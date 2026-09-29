type Unit = { name: string; code: string };
export type VerifiedCourse = { title: string; url: string; matchedUnit: string; evidence: string };

// A search hit is a lead, not evidence of a course. Verify the publisher's page.
export async function courseLinks(result: unknown, units: Unit[], fetchPage: typeof fetch = fetch): Promise<VerifiedCourse[]> {
  if (!result || typeof result !== 'object' || !('output' in result) || typeof result.output !== 'string') return [];
  const hits = [...result.output.matchAll(/^- \[([^\]\n]+)\]\((https:\/\/[^\s)]+)\)/gm)].slice(0, 10);
  const courses: VerifiedCourse[] = [];
  for (const [, , url] of hits) {
    if (!url || courses.some(course => course.url === url)) continue;
    let page: Response;
    try {
      page = await fetchPage(url, { signal: AbortSignal.timeout(8000), redirect: 'error' });
      if (!page.ok || !page.headers.get('content-type')?.includes('text/html')) continue;
    } catch { continue; }
    let html: string;
    try { html = (await page.text()).slice(0, 500_000); } catch { continue; }
    // Only a publisher-declared Course (not a document with a promising link title)
    // establishes that the destination is actually an educational offering.
    for (const [, block] of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
      let data: unknown;
      try { data = JSON.parse(block!); } catch { continue; }
      const candidates = Array.isArray(data) ? data : [data];
      for (const candidate of candidates) {
        const entries = candidate && typeof candidate === 'object' && '@graph' in candidate && Array.isArray(candidate['@graph']) ? candidate['@graph'] : [candidate];
        for (const entry of entries) {
          if (!entry || typeof entry !== 'object') continue;
          const record = entry as Record<string, unknown>;
          const types = Array.isArray(record['@type']) ? record['@type'] : [record['@type']];
          if (!types.includes('Course') && !types.includes('https://schema.org/Course')) continue;
          const title = typeof record.name === 'string' ? record.name.trim() : '';
          const description = typeof record.description === 'string' ? record.description.trim() : '';
          if (!title || !description) continue;
          const unit = units.find(({ name, code }) => !!code && name.trim().length >= 3 &&
            (title.includes(name.trim()) || description.includes(name.trim())));
          if (!unit) continue;
          courses.push({ title, url, matchedUnit: `${unit.code} ${unit.name}`, evidence: `발행 페이지 Course 메타데이터의 이름·설명에서 NCS 능력단위 「${unit.name}」 확인` });
          break;
        }
        if (courses.some(course => course.url === url)) break;
      }
      if (courses.some(course => course.url === url)) break;
    }
  }
  return courses;
}
