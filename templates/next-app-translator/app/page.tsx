const languages = ['한국어', 'English', '日本語', 'Français'];

export default function TranslatorPage() {
  return (
    <main>
      <h1>나만의 음성 번역기</h1>
      <p>음성을 녹음하고 번역할 언어를 선택하세요.</p>
      <label htmlFor="target-language">번역할 언어</label>
      <select id="target-language" defaultValue="English">
        {languages.map(language => <option key={language}>{language}</option>)}
      </select>
      <button type="button" disabled>녹음하기</button>
      <p>녹음 및 번역 실행은 앱 액션 런타임 연결 후 사용할 수 있습니다.</p>
    </main>
  );
}
