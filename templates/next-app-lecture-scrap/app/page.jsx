import Link from 'next/link';

export default function LectureList() {
  return <main style={{ maxWidth: 760, margin: '48px auto', padding: 24 }}>
    <header><p>LECTURE SCRAP</p><h1>스크랩 목록</h1><p>수업 자료와 읽을 거리를 한곳에 모아 보세요.</p></header>
    <nav aria-label="주요 메뉴"><Link href="/notes/new">노트 작성</Link> · <Link href="/search">검색</Link></nav>
    <section aria-label="최근 스크랩"><article><h2>분산 시스템 특강</h2><p>오늘 수업에서 다룬 시스템 설계 자료</p></article></section>
  </main>;
}
