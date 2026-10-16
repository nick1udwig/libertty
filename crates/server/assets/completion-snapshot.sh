
  {
    builtin declare -f
    builtin complete -p
    local libertty_completion_var
    while IFS= read -r libertty_completion_var; do
      case "$libertty_completion_var" in
        _*|*COMPLETION*|COMP_WORDBREAKS)
          builtin declare -p "$libertty_completion_var" 2>/dev/null ;;
      esac
    done < <(builtin compgen -A variable)
  } > "$LIBERTTY_COMPLETIONS_FILE.tmp"
  command mv -f -- "$LIBERTTY_COMPLETIONS_FILE.tmp" "$LIBERTTY_COMPLETIONS_FILE"
