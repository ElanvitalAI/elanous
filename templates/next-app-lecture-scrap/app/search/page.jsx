import Link from 'next/link';

export default function SearchLibrary() {
  return <main style={{ maxWidth: 760, margin: '48px auto', padding: 24 }}>
    <header><p>LECTURE SCRAP</p><h1>검색</h1><p>저장한 스크랩과 강의 노트를 찾아보세요.</p></header>
    <form><label htmlFor="query">자료 검색</label><input id="query" name="query" type="search" placeholder="제목이나 내용" />
      <button type="button">검색 · 데모 화면</button><p>이 시연 템플릿에서는 검색을 실행하지 않습니다.</p></form>
    <Link href="/">스크랩 목록으로</Link>
  </main>;
}
