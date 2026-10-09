#!/usr/bin/env python3
# 출처: 공냥이 AI 실험실 «악역영애 말포이» AI 영상 제작 키트(https://malfoy-meme-making.vercel.app/) · 원작자 허락(2026-10-08) · 출처 명기 조건
# 원본: 키트 tools/05_matte/bin/keyer.py (하이브리드 매팅: 로컬 플레이트 색차 키 + isnet-anime 가이드)
# 변경(mac): Windows DirectML 워커(DmlMasker·wslpath) 제거 · AI 백엔드 = cpu | coreml (rembg/onnxruntime 공급자) ·
#   U2NET_HOME 기본 ~/.u2net · 필요 환경: python3 numpy opencv-python pillow rembg + ffmpeg/ffprobe
"""Blue-screen matte for Flow character clips: local-plate color-difference key (+ optional isnet-anime guide).

Stream: ffmpeg decode (rgb24) -> per-frame matte -> ffmpeg encode (rgba) to webm / mov / png sequence.

Per frame
  1. seeds   = strongly blue-dominant pixels (hue-relative, so shadowed/darkened blue still counts)
  2. plate   = local screen color, filled from seeds by push-pull (follows gradients, shadows, hue drift)
  3. alpha   = 1 - (B - max(R,G)) / (plateB - max(plateR,plateG))     (color-difference key vs local plate)
  4. AI guide (optional, isnet-anime): outside dilated mask -> 0 (garbage), inside eroded mask -> 1 (core protect)
  5. color   = unmix against plate, then blue despill B <= max(R,G); transparent RGB bled from edge colors
"""
import argparse, os, subprocess, sys, time, json, threading, queue, collections
import numpy as np, cv2

def probe(path):
    out = subprocess.check_output(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                                   "stream=width,height,r_frame_rate,nb_frames", "-of", "json", path])
    s = json.loads(out)["streams"][0]
    num, den = map(int, s["r_frame_rate"].split("/"))
    return s["width"], s["height"], num / den, int(s.get("nb_frames") or 0)

def pushpull_fill(img, w, levels=7):
    """Fill pixels where w==0 from neighbours (normalized convolution pyramid). img HxWxC float, w HxW float."""
    h, wd = w.shape
    pyr = [(img * w[..., None], w)]
    for _ in range(levels):
        ci, cw = pyr[-1]
        if min(cw.shape) < 8: break
        pyr.append((cv2.pyrDown(ci), cv2.pyrDown(cw)))
    ci, cw = pyr[-1]
    est = ci / np.maximum(cw, 1e-6)[..., None]
    for ci, cw in reversed(pyr[:-1]):
        up = cv2.resize(est, (cw.shape[1], cw.shape[0]), interpolation=cv2.INTER_LINEAR)
        k = np.clip(cw * 4, 0, 1)[..., None]
        est = (ci / np.maximum(cw, 1e-6)[..., None]) * k + up * (1 - k)
    return est

class Keyer:
    def __init__(self, a, W=0, H=0):
        self.a = a
        self.sess = None
        self.dml = None
        if a.ai:
            os.environ.setdefault("U2NET_HOME", os.path.expanduser("~/.u2net"))
            from rembg import new_session
            providers = (["CoreMLExecutionProvider", "CPUExecutionProvider"] if a.ai_backend == "coreml"
                         else ["CPUExecutionProvider"])
            self.sess = new_session(a.ai_model, providers=providers)
        self.prev_plate = None
        self.prev_m = None
        self.n = 0

    def ai_mask(self, rgb):
        from rembg import remove
        from PIL import Image
        m = remove(Image.fromarray(rgb), session=self.sess, only_mask=True)
        return np.asarray(m, np.float32) / 255.0

    def __call__(self, rgb_u8):
        a = self.a
        f = rgb_u8.astype(np.float32)
        R, G, B = f[..., 0], f[..., 1], f[..., 2]
        mx = np.maximum(R, G)
        d = B - mx                                                   # blue dominance
        # 1. seeds: blue clearly dominant relative to brightness (works on darkened / shadowed screen)
        m = None
        if self.sess is not None:
            if self.n % max(self.a.ai_every, 1) == 0 or self.prev_m is None:
                self.prev_m = self.ai_mask(rgb_u8)
            m = self.prev_m
        self.n += 1
        if m is None:
            seed = (d > a.seed_min) & (d > a.seed_ratio * B)
        else:   # AI says where the subject is -> seeds may be much looser (catches shadowed / hue-drifted screen)
            far = cv2.dilate((m > 0.3).astype(np.uint8), np.ones((13, 13), np.uint8)) == 0
            seed = (d > a.ai_seed_min) & (d > a.ai_seed_ratio * B) & far
        seed = cv2.erode(seed.astype(np.uint8), np.ones((5, 5), np.uint8)).astype(np.float32)
        # 2. local plate at 1/4 res
        sm = cv2.resize(f, None, fx=0.25, fy=0.25, interpolation=cv2.INTER_AREA)
        sw = cv2.resize(seed, None, fx=0.25, fy=0.25, interpolation=cv2.INTER_AREA)
        sw = (sw > 0.99).astype(np.float32)
        if sw.sum() < 50:                                            # no screen visible: fall back to previous / nominal
            plate_s = self.prev_plate if self.prev_plate is not None else np.full_like(sm, 0) + np.array(a.screen, np.float32)
        else:
            plate_s = pushpull_fill(sm, sw)
            if self.prev_plate is not None and a.plate_smooth > 0:   # temporal smoothing of plate (flicker guard)
                plate_s = a.plate_smooth * self.prev_plate + (1 - a.plate_smooth) * plate_s
        self.prev_plate = plate_s
        plate = cv2.resize(plate_s, (f.shape[1], f.shape[0]), interpolation=cv2.INTER_LINEAR)
        pd = np.maximum(plate[..., 2] - np.maximum(plate[..., 0], plate[..., 1]), 20.0)
        # 3. color-difference alpha vs local plate
        alpha = 1.0 - np.clip(d / pd, 0, 1)
        alpha = np.clip((alpha - a.clip_black) / max(a.clip_white - a.clip_black, 1e-3), 0, 1)
        # 4. AI guide
        if m is not None:
            k = lambda r: cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))
            if a.garbage_full:
                garbage = cv2.dilate((m > 0.05).astype(np.uint8), k(a.garbage_px)).astype(np.float32)
                garbage = cv2.GaussianBlur(garbage, (0, 0), a.garbage_px / 3)
            else:   # same matte at 1/4 res (max-pool down so it only grows; ~10x cheaper than an 81px ellipse at full res)
                hs, ws = (f.shape[0] + 3) // 4, (f.shape[1] + 3) // 4
                g = cv2.resize((m > 0.05).astype(np.float32), (ws, hs), interpolation=cv2.INTER_AREA) > 0
                g = cv2.dilate(g.astype(np.uint8), k(max(a.garbage_px // 4, 1))).astype(np.float32)
                g = cv2.GaussianBlur(g, (0, 0), a.garbage_px / 12)
                garbage = cv2.resize(g, (f.shape[1], f.shape[0]), interpolation=cv2.INTER_LINEAR)
            core = cv2.erode((m > 0.9).astype(np.uint8), k(a.core_px)).astype(np.float32)
            core = cv2.GaussianBlur(core, (0, 0), a.core_px / 3)
            alpha = np.maximum(alpha * garbage, core)
        # despeckle: tiny isolated alpha islands in the screen area
        if a.despeckle:
            alpha[(alpha < 0.08)] = 0
        # 5. colour: unmix screen contribution, then despill
        ae = np.maximum(alpha, 1e-3)[..., None]
        fg = (f - (1 - alpha[..., None]) * plate) / ae
        fg = np.where(alpha[..., None] > 0.97, f, fg)                # solid interior: keep source pixels untouched
        fg = np.clip(fg, 0, 255)
        fr, fgc, fb = fg[..., 0], fg[..., 1], fg[..., 2]
        lim = np.maximum(fr, fgc) if a.despill == "max" else (fr + fgc) / 2
        fg[..., 2] = np.minimum(fb, lim + a.despill_bias)
        # bleed edge colours into transparent area so 4:2:0 / filtering never shows blue fringes
        wfill = (alpha > 0.5).astype(np.float32)
        if wfill.sum() > 0:
            bled = pushpull_fill(cv2.resize(fg, None, fx=0.5, fy=0.5, interpolation=cv2.INTER_AREA),
                                 cv2.resize(wfill, None, fx=0.5, fy=0.5, interpolation=cv2.INTER_AREA))
            bled = cv2.resize(bled, (f.shape[1], f.shape[0]))
            t = np.clip(alpha * 4, 0, 1)[..., None]
            fg = fg * t + bled * (1 - t)
        out = np.empty(f.shape[:2] + (4,), np.uint8)
        out[..., :3] = np.clip(fg, 0, 255)
        out[..., 3] = alpha * 255
        return out

def main():
    p = argparse.ArgumentParser()
    p.add_argument("input"); p.add_argument("--webm"); p.add_argument("--mov"); p.add_argument("--png-dir")
    p.add_argument("--ai", action="store_true", help="use isnet-anime guide (garbage + core protect)")
    p.add_argument("--ai-model", default="isnet-anime")
    p.add_argument("--ai-backend", choices=["cpu", "coreml"], default="cpu",
                   help="cpu = rembg CPU provider; coreml = onnxruntime CoreML provider first (Apple silicon), CPU fallback")
    p.add_argument("--ai-every", type=int, default=1, help="run AI guide every N frames (2 = ~2x faster, ok for slow motion)")
    p.add_argument("--screen", type=float, nargs=3, default=[30, 60, 255], help="nominal screen RGB fallback")
    p.add_argument("--seed-min", type=float, default=60); p.add_argument("--seed-ratio", type=float, default=0.55)
    p.add_argument("--ai-seed-min", type=float, default=25); p.add_argument("--ai-seed-ratio", type=float, default=0.3)
    p.add_argument("--clip-black", type=float, default=0.12, help="alpha below -> 0 (kills screen noise)")
    p.add_argument("--clip-white", type=float, default=0.85, help="alpha above -> 1 (solidifies body)")
    p.add_argument("--garbage-full", action="store_true", help="garbage matte at full res (old path, slower)")
    p.add_argument("--garbage-px", type=int, default=40); p.add_argument("--core-px", type=int, default=14)
    p.add_argument("--despill", choices=["max", "avg"], default="max"); p.add_argument("--despill-bias", type=float, default=0)
    p.add_argument("--plate-smooth", type=float, default=0.5); p.add_argument("--despeckle", type=int, default=1)
    p.add_argument("--start", type=float, default=0); p.add_argument("--duration", type=float, default=0)
    p.add_argument("--crf", type=int, default=18)
    p.add_argument("--max-frames", type=int, default=0)
    a = p.parse_args()
    W, H, fps, n = probe(a.input)
    dec = ["ffmpeg", "-v", "error"] + (["-ss", str(a.start)] if a.start else []) + ["-i", a.input] + \
          (["-t", str(a.duration)] if a.duration else []) + ["-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    enc = ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{W}x{H}", "-r", f"{fps}", "-i", "-"]
    if a.webm:
        enc += ["-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-crf", str(a.crf), "-b:v", "0", "-auto-alt-ref", "0",
                "-row-mt", "1", "-deadline", "good", "-cpu-used", "4", "-metadata:s:v:0", "alpha_mode=1", a.webm]
    if a.mov:
        enc += ["-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le", "-alpha_bits", "16",
                "-vendor", "apl0", a.mov]
    if a.png_dir:
        os.makedirs(a.png_dir, exist_ok=True)
        enc += ["-c:v", "png", "-pix_fmt", "rgba", os.path.join(a.png_dir, "%05d.png")]
    keyer = Keyer(a, W, H)
    dp = subprocess.Popen(dec, stdout=subprocess.PIPE)
    ep = subprocess.Popen(enc, stdin=subprocess.PIPE)
    fsz = W * H * 3; i = 0; t0 = time.time(); tk = 0.0
    ahead = collections.deque(); nread = 0; eof = False; every = max(a.ai_every, 1)
    lim = a.max_frames or 10**12
    def read_one():
        nonlocal nread, eof
        if eof or nread >= lim: eof = True; return
        buf = dp.stdout.read(fsz)
        if len(buf) < fsz: eof = True; return
        fr = np.frombuffer(buf, np.uint8).reshape(H, W, 3)
        ahead.append(fr); nread += 1
    while True:
        while not eof and not ahead: read_one()
        if not ahead: break
        frame = ahead.popleft()
        t = time.time()
        out = keyer(frame)
        tk += time.time() - t
        ep.stdin.write(out.tobytes()); i += 1
        if i % 30 == 0: print(f"[matte] {i} frames  {tk / i:.3f}s/frame", file=sys.stderr, flush=True)
    dp.kill(); dp.stdout.close(); ep.stdin.close(); ep.wait(); dp.wait()
    print(json.dumps({"frames": i, "matte_s_per_frame": round(tk / max(i, 1), 3), "wall_s": round(time.time() - t0, 1),
                      "ai": bool(a.ai), "ai_backend": a.ai_backend if a.ai else None}))

if __name__ == "__main__":
    main()
