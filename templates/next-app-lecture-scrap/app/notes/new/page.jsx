import Link from 'next/link';

export default function NewLectureNote() {
  return <main style={{ maxWidth: 760, margin: '48px auto', padding: 24 }}>
    <header><p>LECTURE SCRAP</p><h1>노트 작성</h1><p>강의에서 기억할 내용을 짧게 적어 두세요.</p></header>
    <form><label htmlFor="title">강의 제목</label><input id="title" name="title" />
      <label htmlFor="body">강의 노트</label><textarea id="body" name="body" rows={8} />
      <button type="button">노트 저장 · 데모 화면</button><p>이 시연 템플릿에서는 입력을 저장하지 않습니다.</p></form>
    <Link href="/">스크랩 목록으로</Link>
  </main>;
}
