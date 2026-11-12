# CodeViser basic debug procedures

Use this skill when a user explicitly asks to initialize or test a CodeViser CVD target.

Available approved CMM scripts:

- `system_up`: runs `SYStem.Up`. This changes the target debug state and requires the `scripts` or `unrestricted` access policy.
- `print_api_ready`: prints a harmless marker in the CVD command area.

Call the MCP tool `cvd_run_script` with:

```json
{
  "skill": "codeviser-debug-basic",
  "script": "system_up",
  "arguments": {}
}
```

Do not convert these scripts into raw `cvd_command` calls. The script tool validates the approved skill path and the CMM interface header.
