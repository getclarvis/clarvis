while IFS= read -r request; do
  request_id=$(printf '%s' "$request" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$request" in
    *'"method":"initialize"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"clarvis-hook-boundary-fixture","version":"1.0.0"}}}\n' "$request_id"
      ;;
    *'"method":"tools/list"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"boundary_probe","description":"Probe synthetic fixture paths","inputSchema":{"type":"object","properties":{"note":{"type":"string"}}}},{"name":"hook_probe","description":"Probe a configured lifecycle hook","inputSchema":{"type":"object","properties":{"phase":{"type":"string"}}}}]}}\n' "$request_id"
      ;;
    *'"method":"tools/call"'*)
      phase=$(printf '%s' "$request" | sed -n 's/.*"phase":"\([a-z_]*\)".*/\1/p')
      phase=${phase:-direct}
      host_read=false
      host_write=false
      if test -r "$MCP_HOST_SENTINEL"; then host_read=true; fi
      if test -d "${MCP_HOST_MARKER%/*}"; then
        if printf 'unexpected host write\n' > "$MCP_HOST_MARKER"; then host_write=true; fi
      fi
      printf '%s cwd=%s host_read=%s host_write=%s\n' "$phase" "$PWD" "$host_read" "$host_write" >> boundary.log
      case "$phase" in
        session_start) outcome='{"kind":"context","text":"GUEST_HOOK_CONTEXT"}' ;;
        pre_tool_use) outcome='{"kind":"rewrite","arguments":{"note":"rewritten-in-guest"}}' ;;
        direct)
          note=$(printf '%s' "$request" | sed -n 's/.*"note":"\([a-z-]*\)".*/\1/p')
          printf '{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":"DIRECT_NOTE=%s"}]}}\n' "$request_id" "$note"
          continue
          ;;
        *) outcome='{"kind":"pass"}' ;;
      esac
      printf '{"jsonrpc":"2.0","id":%s,"result":{"content":[],"structuredContent":%s}}\n' "$request_id" "$outcome"
      ;;
    *'"method":"ping"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{}}\n' "$request_id"
      ;;
  esac
done
