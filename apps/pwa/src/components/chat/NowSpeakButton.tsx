'use client';

import { useEffect, useRef, useState } from 'react';
import { Volume2 } from 'lucide-react';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { debugLog } from '@/lib/debug';

/** Fetch the daemon's existing two-sentence voice projection on demand. */
export function NowSpeakButton() {
  const { client } = useDaemon();
  const [supported, setSupported] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const busy = useRef(false);
  const generation = useRef(0);
  const speaking = useRef(false);

  useEffect(() => {
    setSupported(typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined');
    return () => {
      generation.current++;
      if (speaking.current && typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
    };
  }, []);

  const speakNow = async () => {
    if (busy.current || !supported) return;
    busy.current = true;
    const request = ++generation.current;
    setLoading(true);
    setError('');
    // Avoid cancelling voice chat unless this button has started a reading.
    if (speaking.current) window.speechSynthesis.cancel();
    speaking.current = false;
    try {
      const response = await client.fetchResponse('/v1/context/now?format=voice', { method: 'GET' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body: unknown = await response.json();
      if (!body || typeof body !== 'object' || !('text' in body) || typeof body.text !== 'string' || !body.text.trim()) {
        throw new Error('invalid voice summary');
      }
      if (request !== generation.current) return;
      const utterance = new SpeechSynthesisUtterance(body.text);
      utterance.lang = 'ko-KR';
      utterance.onend = () => { if (request === generation.current) speaking.current = false; };
      utterance.onerror = () => { if (request === generation.current) speaking.current = false; };
      speaking.current = true;
      window.speechSynthesis.speak(utterance);
      debugLog('chat.now.speak', { outcome: 'spoken' });
    } catch (cause) {
      if (request !== generation.current) return;
      speaking.current = false;
      setError('지금 상황을 읽지 못했습니다. 다시 시도해 주세요.');
      debugLog('chat.now.speak', { outcome: 'error', reason: String(cause) });
    } finally {
      if (request === generation.current) {
        busy.current = false;
        setLoading(false);
      }
    }
  };

  return <div className="flex shrink-0 items-center gap-1">
    <button
      type="button"
      data-elanous-action="chat-now-speak"
      aria-label="지금 상황 듣기"
      title={!supported ? '이 브라우저는 음성 읽기를 지원하지 않습니다' : '지금 상황 두 문장 듣기'}
      disabled={!supported || loading}
      onClick={() => void speakNow()}
      className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-border bg-background px-3 text-xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
    >
      <Volume2 className="h-4 w-4" aria-hidden="true" />
      <span>지금 상황 듣기</span>
    </button>
    {error && <span role="alert" className="text-xs text-rose-600">{error}</span>}
  </div>;
}
