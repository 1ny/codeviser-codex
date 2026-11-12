# CodeViser–Codex Bridge

CodeViser CVD가 설치된 Windows PC에 Codex 전역 MCP 연동을 추가합니다. CVD 프로그램, 드라이버, 펌웨어, `CVDAPI.dll` 는 포함하지 않으므로 기존에 설치되어있음을 전재합니다.

## 구조

```text
Codex → codeviser MCP(Node.js) → 영구 32비트 PowerShell 브리지
      → CVDAPI.dll → CVD-Multi-Server:8888 → CVD Master:20000 → 타깃
```

MCP 서버가 실행되는 동안 하나의 32비트 브리지를 유지합니다. 각 도구 호출마다 `CVD_Init/Connect/Config/Quit`를 반복하지 않으며, 읽기 도구는 브리지 전송 오류가 발생하면 한 번 자동 재연결합니다. 변경 작업은 중복 실행 위험 때문에 자동 재시도하지 않습니다.

## 설치

ZIP 또는 저장소를 CodeViser 설치 루트 아래에 배치하는 것을 권장합니다.

```text
C:\JnDTech\CodeViser-Codex-Bridge\
```

기본 설치 정책은 `scripts`입니다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

보드 초기화 CMM도 CVD 시작 시 실행하려면:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 `
  -AutoStartScript "C:\CVD\autostart.cmm"
```

설치 경로가 다르면:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 `
  -CvdRoot "D:\JnDTech\CVI\CVD"
```

설치 후 Codex Desktop을 완전히 종료하고 다시 실행합니다.

## 실행 정책

정책은 설치할 때 선택할 수 있고, 나중에 같은 설치 명령을 다른 정책으로 다시 실행하여 변경할 수 있습니다. Codex가 MCP 도구로 스스로 정책을 올릴 수는 없습니다.

### readonly

- 연결, 상태, PC, 레지스터, 메모리, 심볼 읽기
- 소스 및 메뉴 검색
- Run, Stop, Reset, CMM, 임의 명령 차단

```powershell
.\install.ps1 -CvdAccessPolicy readonly
```

### scripts — 기본값

- `readonly` 기능
- 명시적으로 요청된 Run, Stop, Reset
- 승인된 스킬 폴더의 `safe=true` CMM 실행
- 임의 `cvd_command` 차단

```powershell
.\install.ps1 -CvdAccessPolicy scripts
```

### unrestricted

- 모든 기능 및 정확한 CVD 명령
- 통제된 개발 PC에서만 권장
- GUI 자동화는 별도 옵션을 주지 않으면 여전히 비활성화

```powershell
.\install.ps1 -CvdAccessPolicy unrestricted
```

GUI 키 입력까지 허용하려면:

```powershell
.\install.ps1 -CvdAccessPolicy unrestricted -EnableGuiAutomation
```

현재 정책은 `~\.codex\config.toml`의 `CVD_ACCESS_POLICY` 환경값으로 저장됩니다. 직접 변경한 경우 Codex Desktop을 재시작해야 합니다.

전체 설치를 다시 하지 않고 다음 실행부터 정책만 바꾸려면:

```powershell
.\set-policy.ps1 -Policy readonly
.\set-policy.ps1 -Policy scripts
.\set-policy.ps1 -Policy unrestricted
```

정책 변경 후에는 Codex Desktop을 완전히 종료하고 다시 시작합니다. 실행 중인 MCP 세션의 정책은 바뀌지 않습니다.

## 자동 MCP 선택

MCP 초기화 응답에 서버 instructions가 포함됩니다. Codex는 사용자가 `codeviser MCP를 사용해서`라고 쓰지 않아도 다음 문맥을 보면 먼저 `cvd_get_status`를 고려할 수 있습니다.

- CVD, CodeViser, 디버거
- 타깃, 보드, 코어, PC
- 레지스터, 메모리, 심볼, CMM
- 임베디드 디버깅 상태

이는 강제 라우팅 규칙이 아니라 모델에 제공되는 명확한 서버 사용 지침입니다. 이름이 매우 모호한 요청에는 `CodeViser` 또는 `CVD`를 적어 주는 편이 여전히 확실합니다.

## 통합 상태 도구

다음처럼 요청합니다.

```text
현재 디버거 연결과 타깃 상태, PC를 한 번에 확인해줘.
```

Codex는 `cvd_get_status`를 호출하고 다음 구조의 결과를 받습니다.

```json
{
  "policy": "scripts",
  "api": {
    "connected": true,
    "session": 1,
    "multiServerPort": 8888,
    "cvdMasterPort": 20000
  },
  "target": {
    "cvdState": 0,
    "debugState": 0,
    "pc": "0x00451D70",
    "errors": []
  }
}
```

결과는 사람이 읽는 텍스트와 MCP `structuredContent`를 함께 제공합니다.

## 승인된 CMM 스킬

기본 스킬은 다음 구조입니다.

```text
skills/
└─ codeviser-debug-basic/
   ├─ SKILL.md
   └─ scripts/
      ├─ system_up.cmm
      └─ print_api_ready.cmm
```

사용 예:

```text
승인된 CodeViser 기본 스킬로 system_up CMM을 실행해줘.
```

내부 호출:

```json
{
  "skill": "codeviser-debug-basic",
  "script": "system_up",
  "arguments": {}
}
```

각 CMM은 파일 앞부분에 실행 인터페이스를 선언합니다.

```c
; {
;   "interface": 1,
;   "safe": true,
;   "arguments": {
;     "symbol": { "type": "symbol" },
;     "count": { "type": "number", "optional": true }
;   }
; }
```

지원 인자 형식은 `address`, `symbol`, `wildcard`, `number`, `string`, `enum`, 앵커가 포함된 `pattern`입니다. 필수 인자 누락, 알 수 없는 인자, 줄바꿈·따옴표 등 위험 문자는 서버에서 거부합니다.

외부 스킬 루트를 추가하려면:

```powershell
.\install.ps1 -CvdAccessPolicy scripts `
  -ApprovedScriptRoot "D:\Company\CodeViserSkills"
```

기본 내장 스킬 루트도 자동으로 함께 등록됩니다.

## 명령 및 CMM 결과

`CVD_Cmd()`는 명령 접수 여부만 반환하고 CVD 명령창의 `PRINT` 텍스트를 돌려주지 않습니다. 따라서 현재 브리지는 명령 전후에 다음 상태를 관찰하여 구조화된 결과로 반환합니다.

- CVD state
- Debug state
- PC
- 각 읽기 실패 사유

응답의 `outputCapture` 값은 `state-observation`입니다. 추후 CodeViser가 콘솔 출력 API 또는 안전한 파일 리디렉션 규격을 제공하면 실제 텍스트 캡처로 확장할 수 있습니다.

## GUI 자동화

메뉴 검색과 메뉴 실행은 분리되어 있습니다.

- `cvd_search_menu`, `cvd_list_menus`: 모든 정책에서 읽기 전용으로 사용
- `cvd_execute_menu`: `unrestricted` 및 `-EnableGuiAutomation`일 때만 노출

GUI 키 입력은 별도 `cvd-gui.ps1` 프로세스에서 수행되어 CVD API 연결과 격리됩니다. 창 포커스, 원격 데스크톱 잠금, 관리자 권한 차이의 영향을 받을 수 있습니다.

## 테스트

실제 CVD 없이 mock 브리지로 MCP 계약, 정책, CMM 인자 검증, 영구 브리지 재사용을 검사합니다.

```powershell
node --test tests/*.test.mjs
```

PowerShell 구문과 Node.js 구문도 함께 검사할 수 있습니다.

```powershell
node --check mcp/server.mjs
```

## 제거

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1
```

CodeViser 설치 파일, 보드 파일 및 사용자 CMM은 삭제하지 않습니다.
