export function isFactQuestion(userText: string): boolean {
  const text = userText.trim();
  if (!text || text.length > 120 || /[\r\n]/.test(text)) return false;
  if (/`|\bsrc\/|(?:^|[\s/])[^\s/]+\.(?:ts|tsx|js|jsx|json|md|py|sh|yaml|yml)\b|고쳐|구현|실행|만들어|수정|디버그|파일|읽어|열어|저장|작성|삭제|편집|검색해|찾아줘|보여줘|\/cc\b|delegate_code_agent/i.test(text)) return false;
  // A request («…해줘?», «재시작해», «restart …») is work, not a fact question — even with a «?» or «지금»(round 3: «지금 서버를 재시작해줘?»).
  const request = text.replace(/알려\s*(?:줘|주세요|줄래|주실래요)[?？]?$/, '');
  if (/(?:해|해\s*줘|해\s*주세요|하세요|해라|하자|줘|주세요|줄래|주실래요|봐|봐줘)[?？]?$/.test(request)) return false;
  if (/재시작|시작|중지|멈춰|꺼|켜|설치|배포|돌려|보내|올려|지워|바꿔|추가|업데이트|재부팅|재실행|정리|등록|\b(?:restart|start|stop|run|install|deploy|delete|remove|create|update|fix|kill|reboot)\b/i.test(text)) return false;
  if (!/[?？]$|(?:뭐야|무엇인가요|인가요|나요|입니까|얼마야|언제야|누구야|알려줘|알려주세요)$/.test(text)) return false;
  return /최근|최신|지금|현재|몇|언제|누가|누구|얼마|가격|버전|출시|최저시급|\b(?:latest|current|when|who|how many|how much|price|version|release)\b/i.test(text);
}
