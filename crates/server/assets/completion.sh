
exec 3>&1
{
  shopt -s extglob progcomp
  if [[ -n "$LIBERTTY_COMPLETIONS_FILE" && -r "$LIBERTTY_COMPLETIONS_FILE" ]]; then
    source "$LIBERTTY_COMPLETIONS_FILE"
  elif [[ -r /usr/share/bash-completion/bash_completion ]]; then
    source /usr/share/bash-completion/bash_completion
  elif [[ -r /etc/bash_completion ]]; then
    source /etc/bash_completion
  fi
  COMP_LINE=$1; shift
  COMP_POINT=${#COMP_LINE} COMP_TYPE=9 COMP_KEY=9
  COMP_WORDS=("$@") COMP_CWORD=$(($# - 1)) COMPREPLY=()
  libertty_completion_command=$1
  libertty_completion_current=${COMP_WORDS[COMP_CWORD]}
  libertty_completion_previous=${COMP_WORDS[COMP_CWORD-1]}
  for libertty_completion_attempt in 1 2; do
    libertty_completion_spec=$(builtin complete -p -- "$libertty_completion_command")
    if [[ -z "$libertty_completion_spec" ]]; then
      if builtin declare -F _comp_load >/dev/null; then _comp_load -- "$libertty_completion_command"
      elif builtin declare -F _completion_loader >/dev/null; then _completion_loader "$libertty_completion_command"
      fi
      libertty_completion_spec=$(builtin complete -p -- "$libertty_completion_command")
    fi
    [[ -n "$libertty_completion_spec" ]] || break
    eval "libertty_completion_args=(${libertty_completion_spec#complete })"
    libertty_completion_function= libertty_completion_external= libertty_completion_options=()
    for ((libertty_completion_index=0; libertty_completion_index<${#libertty_completion_args[@]}-1; libertty_completion_index++)); do
      libertty_completion_option=${libertty_completion_args[libertty_completion_index]}
      case "$libertty_completion_option" in
        -F) libertty_completion_function=${libertty_completion_args[++libertty_completion_index]} ;;
        -C) libertty_completion_external=1; ((libertty_completion_index++)) ;;
        -o) ((libertty_completion_index++)) ;;
        *) libertty_completion_options+=("$libertty_completion_option") ;;
      esac
    done
    if [[ -n "$libertty_completion_function" ]]; then
      "$libertty_completion_function" "$libertty_completion_command" "$libertty_completion_current" "$libertty_completion_previous"
      [[ $? == 124 ]] && continue
    elif [[ -z "$libertty_completion_external" && ${#libertty_completion_options[@]} -gt 0 ]]; then
      mapfile -t COMPREPLY < <(builtin compgen "${libertty_completion_options[@]}" -- "$libertty_completion_current")
    fi
    break
  done
} >/dev/null 2>&1
if ((${#COMPREPLY[@]})); then builtin printf '%s\0' "${COMPREPLY[@]:0:1000}" >&3; fi
