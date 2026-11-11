import Link from 'next/link';

export default function LectureList() {
  return <main style={{ maxWidth: 760, margin: '48px auto', padding: 24 }}>
    <header><p>LECTURE SCRAP</p><h1>날짜별 기록</h1><p>녹음 날짜와 수업일을 구분하고, 논리 폴더별로 강의 자료를 모아 보는 데모 화면입니다.</p></header>
    <nav aria-label="주요 메뉴"><Link href="/notes/new">노트 작성</Link> · <Link href="/search">검색</Link></nav>
    <section aria-label="최근 스크랩"><h2>2026-11-14 · 강의 자료</h2><article><h3>분산 시스템 특강</h3><p>기록일 (녹음 시작 기준): 2026-11-14 · 수업일 예시: 2026-11-13</p><p>저장 분류: 강의 자료 폴더 (논리 폴더 예시)</p><p>날짜와 폴더는 정적 목업이며 이 화면은 세션을 저장하지 않습니다.</p></article></section>
  </main>;
}
