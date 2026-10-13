
  {
    builtin declare -f
    builtin complete -p
    local termai_completion_var
    while IFS= read -r termai_completion_var; do
      case "$termai_completion_var" in
        _*|*COMPLETION*|COMP_WORDBREAKS)
          builtin declare -p "$termai_completion_var" 2>/dev/null ;;
      esac
    done < <(builtin compgen -A variable)
  } > "$TERMAI_COMPLETIONS_FILE.tmp"
  command mv -f -- "$TERMAI_COMPLETIONS_FILE.tmp" "$TERMAI_COMPLETIONS_FILE"
