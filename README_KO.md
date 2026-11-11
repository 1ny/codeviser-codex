# CodeViser–Codex Bridge

이 패키지는 **CodeViser CVD가 이미 설치된 Windows PC**에 Codex 전역 MCP 연동만 추가합니다. CVD 프로그램·드라이버·펌웨어와 별도 AI 콘솔은 포함하지 않습니다.

## 원리

```text
Codex 채팅 → codeviser MCP(Node.js) → 32비트 PowerShell 브리지
           → CVDAPI.dll → CVD-Multi-Server:8888 → CVD Master:20000 → 보드
```

Codex가 CodeViser DLL API를 통해 상태·PC·레지스터·메모리·심볼을 읽고, 사용자가 명시한 경우에만 Run/Stop/Reset 또는 정확한 CVD 명령을 전달합니다. Flash/Erase 및 메모리·레지스터 쓰기 도구는 제공하지 않습니다.

런처의 상태 모니터가 열려 있는 동안에는 백그라운드 API keeper가 `CVD_Init → Connect(8888) → Config(20000)` 세션을 유지합니다. 각 AI 도구 호출은 별도 단기 세션으로 순서대로 처리됩니다. 모니터를 `Q` 또는 창 닫기로 종료하면 keeper도 해제되고 CVD GUI는 계속 실행되므로, 수동 Flash 작업에서 API 세션 해제가 필요할 때 사용할 수 있습니다.

## 요구 사항

- Windows, Codex Desktop, CodeViser CVD 및 `CVDAPI.dll`
- 기본 예제 CPU: `S32K312-M7`, JTAG, Master 포트 `20000`
- `test.exe`는 API 세션을 점유할 수 있으므로 종료
   
## 압축 해제 및 설치

ZIP은 **CodeViser 설치 폴더가 들어 있는 JnDTech 루트**에 풉니다. 

```text
C:\JnDTech\CodeViser-Codex-Bridge\
```


압축을 푼 폴더에서 PowerShell을 열고 실행합니다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

`autostart.cmm`이 존재하면 아래와 같이 정확한 경로를 지정합니다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -AutoStartScript "C:\CVD\autostart.cmm"
```

CodeViser 설치 폴더가 기본 경로가 아니면 아래와 같이 경로를 지정합니다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -CvdRoot "C:\JnDTech\CVI\CVD"
```

다른 CPU용 CSF가 있으면 `-MasterConfigPath`로 지정합니다. 이전 옵션명 `-MasterConfig`도 별칭으로 지원합니다. 설치 시 CVD 경로, CMM 경로, MCP 실행 경로가 해당 PC의 절대 경로로 저장됩니다. 설치 후 Codex Desktop을 완전히 재시작합니다.

## 사용

1. 바탕화면의 **CodeViser CVD Master**를 실행합니다. CVD API가 연결되면 설정된 CMM에 `CD.DO "전체경로\autostart.cmm"`를 한 번 실행합니다.
2. PowerShell 상태창에서 최초 API 연결과 `Persistent API connection started`를 확인합니다. 이후에는 TCP Listener 변화가 아니라 실제 API 세션 값이 변경될 때만 연결·해제 상태를 표시합니다. `R`은 실제 API 재검사, `Q`는 모니터와 keeper만 종료하며 CVD는 계속 실행합니다.
3. 실패하면 CVD Master 세션 `20000` 설정과 `test.exe` 종료 여부를 점검합니다. `20000`은 TCP Listener가 아니라 CVD GUI 세션 번호입니다.
4. 새 로컬 Codex 채팅에서 요청합니다.

```text
codeviser의 cvd_health를 호출해줘.
현재 state와 PC를 읽어줘.
정확한 CVD 명령 SYStem.Up을 실행하고 PC를 확인해줘.
```

보드 전원만 켠 것으로 디버그 초기화가 완료되지는 않습니다. 보드용 초기화 스크립트와 `SYStem.Up`이 필요할 수 있습니다. Run/Stop/Reset은 타깃 동작을 바꾸므로 명시적으로 요청할 때만 사용하세요.

상태창 메시지는 Windows 인코딩에 따른 한글 깨짐을 피하기 위해 영문 ASCII로 표시됩니다. 상태창이 열려 있는 동안 keeper가 API 세션을 유지하고, 실제 세션 값이 변경될 때만 연결 상태를 표시합니다. MCP 호출 결과와 오류도 같은 창에 표시되며, 수동 재검사는 `R`을 누르면 수행됩니다.

설치 프로그램은 바탕화면에 별도의 **CodeViser CVD Master** 바로가기를 생성하며, CodeViser 설치 폴더에 포함된 제조사 바로가기는 수정하지 않습니다.

## 배포 범위

이 저장소에는 연동 스크립트와 MCP 서버만 포함합니다. CodeViser CVD, `CVDAPI.dll`, 드라이버, 펌웨어 및 매뉴얼은 J&D Tech가 제공하는 정식 설치본을 사용해야 합니다.

## 제거

압축을 푼 폴더에서 실행합니다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1
```
