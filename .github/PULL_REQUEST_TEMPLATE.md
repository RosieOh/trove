## 개요

<!-- 이 PR이 무엇을 왜 바꾸는지 -->

## 변경 사항

-
-

## 관련 이슈

<!-- 병합 시 자동 종료하려면 아래 형식으로 -->
Closes #

## 체크리스트

- [ ] `npm run typecheck` 통과
- [ ] `npm run lint` 통과
- [ ] `npm test` 통과
- [ ] `npm run test:db` 통과 (색인·스키마·검색 SQL 변경 시)
- [ ] `npx vite build && npm run test:e2e` 통과 (시작·워커·감시·화면 변경 시)
- [ ] 사용자나 기여자가 알아챌 변경이면 `changes/<브랜치>.md` 조각 추가 (`CHANGELOG.md`는 직접 고치지 않음)
- [ ] `~/.claude/` 아래에 쓰기 없음 (읽기 전용 색인, `mkdir` 포함)
- [ ] 사용자 데이터(즐겨찾기·태그)가 행 id가 아닌 `msg_key`를 사용
- [ ] 네트워크 호출 추가 없음 (텔레메트리 금지)
