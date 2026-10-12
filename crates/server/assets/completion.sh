
exec 3>&1
{
  shopt -s extglob progcomp
  if [[ -n "$TERMAI_COMPLETIONS_FILE" && -r "$TERMAI_COMPLETIONS_FILE" ]]; then
    source "$TERMAI_COMPLETIONS_FILE"
  elif [[ -r /usr/share/bash-completion/bash_completion ]]; then
    source /usr/share/bash-completion/bash_completion
  elif [[ -r /etc/bash_completion ]]; then
    source /etc/bash_completion
  fi
  COMP_LINE=$1; shift
  COMP_POINT=${#COMP_LINE} COMP_TYPE=9 COMP_KEY=9
  COMP_WORDS=("$@") COMP_CWORD=$(($# - 1)) COMPREPLY=()
  termai_completion_command=$1
  termai_completion_current=${COMP_WORDS[COMP_CWORD]}
  termai_completion_previous=${COMP_WORDS[COMP_CWORD-1]}
  for termai_completion_attempt in 1 2; do
    termai_completion_spec=$(builtin complete -p -- "$termai_completion_command")
    if [[ -z "$termai_completion_spec" ]]; then
      if builtin declare -F _comp_load >/dev/null; then _comp_load -- "$termai_completion_command"
      elif builtin declare -F _completion_loader >/dev/null; then _completion_loader "$termai_completion_command"
      fi
      termai_completion_spec=$(builtin complete -p -- "$termai_completion_command")
    fi
    [[ -n "$termai_completion_spec" ]] || break
    eval "termai_completion_args=(${termai_completion_spec#complete })"
    termai_completion_function= termai_completion_external= termai_completion_options=()
    for ((termai_completion_index=0; termai_completion_index<${#termai_completion_args[@]}-1; termai_completion_index++)); do
      termai_completion_option=${termai_completion_args[termai_completion_index]}
      case "$termai_completion_option" in
        -F) termai_completion_function=${termai_completion_args[++termai_completion_index]} ;;
        -C) termai_completion_external=1; ((termai_completion_index++)) ;;
        -o) ((termai_completion_index++)) ;;
        *) termai_completion_options+=("$termai_completion_option") ;;
      esac
    done
    if [[ -n "$termai_completion_function" ]]; then
      "$termai_completion_function" "$termai_completion_command" "$termai_completion_current" "$termai_completion_previous"
      [[ $? == 124 ]] && continue
    elif [[ -z "$termai_completion_external" && ${#termai_completion_options[@]} -gt 0 ]]; then
      mapfile -t COMPREPLY < <(builtin compgen "${termai_completion_options[@]}" -- "$termai_completion_current")
    fi
    break
  done
} >/dev/null 2>&1
if ((${#COMPREPLY[@]})); then builtin printf '%s\0' "${COMPREPLY[@]:0:1000}" >&3; fi
