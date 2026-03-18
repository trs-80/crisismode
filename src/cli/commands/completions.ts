// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * `crisismode completions bash|zsh|fish` — print shell completion script to stdout.
 *
 * Usage:
 *   source <(crisismode completions bash)
 *   source <(crisismode completions zsh)
 *   crisismode completions fish > ~/.config/fish/completions/crisismode.fish
 */

const BASH_COMPLETION = `
_crisismode_completions() {
  local cur prev
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  local commands="scan diagnose recover status init demo webhook ask watch completions"
  local global_flags="--config --target --json --no-color --verbose -h --help -v --version"

  if [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( \$(compgen -W "\${commands}" -- "\${cur}") )
    return 0
  fi

  local subcommand="\${COMP_WORDS[1]}"

  if [[ "\${prev}" == "--config" ]]; then
    COMPREPLY=( \$(compgen -f -- "\${cur}") )
    return 0
  fi

  case "\${subcommand}" in
    scan)
      COMPREPLY=( \$(compgen -W "--category --config --verbose --json --no-color -h --help" -- "\${cur}") )
      ;;
    diagnose)
      COMPREPLY=( \$(compgen -W "--config --target --json --no-color --verbose -h --help" -- "\${cur}") )
      ;;
    recover)
      COMPREPLY=( \$(compgen -W "--config --target --execute --health-only --json --no-color --verbose -h --help" -- "\${cur}") )
      ;;
    status)
      COMPREPLY=( \$(compgen -W "--json --no-color -h --help" -- "\${cur}") )
      ;;
    init)
      COMPREPLY=( \$(compgen -W "--agent --json --no-color -h --help" -- "\${cur}") )
      ;;
    demo)
      COMPREPLY=( \$(compgen -W "--json --no-color -h --help" -- "\${cur}") )
      ;;
    webhook)
      COMPREPLY=( \$(compgen -W "--config --execute --json --no-color --verbose -h --help" -- "\${cur}") )
      ;;
    ask)
      COMPREPLY=()
      ;;
    watch)
      COMPREPLY=( \$(compgen -W "--config --target --interval --json --no-color --verbose -h --help" -- "\${cur}") )
      ;;
    completions)
      COMPREPLY=( \$(compgen -W "bash zsh fish" -- "\${cur}") )
      ;;
    *)
      COMPREPLY=( \$(compgen -W "\${global_flags}" -- "\${cur}") )
      ;;
  esac

  return 0
}

complete -F _crisismode_completions crisismode
`.trimStart();

const ZSH_COMPLETION = `
#compdef crisismode

_crisismode() {
  local state line
  typeset -A opt_args

  _arguments -C \\
    '1: :->subcommand' \\
    '*: :->args' \\
    && return 0

  case \$state in
    subcommand)
      local -a subcommands
      subcommands=(
        'scan:Health scan with scored summary'
        'diagnose:Health check and AI-powered diagnosis (read-only)'
        'recover:Full recovery flow (dry-run default)'
        'status:Quick health probe'
        'init:Generate crisismode.yaml or scaffold a check plugin'
        'demo:Run simulator demo'
        'webhook:Start webhook receiver for AlertManager'
        'ask:Natural language AI diagnosis'
        'watch:Continuous shadow observation'
        'completions:Print shell completion script'
      )
      _describe 'subcommand' subcommands
      ;;
    args)
      case \$line[1] in
        scan)
          _arguments \\
            '--category[Comma-separated service kinds to scan]:kinds' \\
            '--config[Path to crisismode.yaml]:config file:_files' \\
            '--verbose[Show additional detail]' \\
            '--json[Machine-readable JSON output]' \\
            '--no-color[Disable colored output]' \\
            {-h,--help}'[Show help]'
          ;;
        diagnose)
          _arguments \\
            '--config[Path to crisismode.yaml]:config file:_files' \\
            '--target[Target name from config]:target name' \\
            '--json[Machine-readable JSON output]' \\
            '--no-color[Disable colored output]' \\
            '--verbose[Show additional detail]' \\
            {-h,--help}'[Show help]'
          ;;
        recover)
          _arguments \\
            '--config[Path to crisismode.yaml]:config file:_files' \\
            '--target[Target name from config]:target name' \\
            '--execute[Enable mutations]' \\
            '--health-only[Health check only, no diagnosis]' \\
            '--json[Machine-readable JSON output]' \\
            '--no-color[Disable colored output]' \\
            '--verbose[Show additional detail]' \\
            {-h,--help}'[Show help]'
          ;;
        status)
          _arguments \\
            '--json[Machine-readable JSON output]' \\
            '--no-color[Disable colored output]' \\
            {-h,--help}'[Show help]'
          ;;
        init)
          _arguments \\
            '--agent[Scaffold a new check plugin]:agent name' \\
            '--json[Machine-readable JSON output]' \\
            '--no-color[Disable colored output]' \\
            {-h,--help}'[Show help]'
          ;;
        demo)
          _arguments \\
            '--json[Machine-readable JSON output]' \\
            '--no-color[Disable colored output]' \\
            {-h,--help}'[Show help]'
          ;;
        webhook)
          _arguments \\
            '--config[Path to crisismode.yaml]:config file:_files' \\
            '--execute[Enable mutations]' \\
            '--json[Machine-readable JSON output]' \\
            '--no-color[Disable colored output]' \\
            '--verbose[Show additional detail]' \\
            {-h,--help}'[Show help]'
          ;;
        ask)
          _arguments '1:question'
          ;;
        watch)
          _arguments \\
            '--config[Path to crisismode.yaml]:config file:_files' \\
            '--target[Target name from config]:target name' \\
            '--interval[Poll interval in seconds]:seconds' \\
            '--json[Machine-readable JSON output]' \\
            '--no-color[Disable colored output]' \\
            '--verbose[Show additional detail]' \\
            {-h,--help}'[Show help]'
          ;;
        completions)
          local -a shells
          shells=('bash:Bash completion script' 'zsh:Zsh completion script' 'fish:Fish completion script')
          _describe 'shell' shells
          ;;
      esac
      ;;
  esac
}

_crisismode
`.trimStart();

const FISH_COMPLETION = `
# Fish completions for crisismode

complete -c crisismode -f

# Subcommands
complete -c crisismode -n '__fish_use_subcommand' -a scan        -d 'Health scan with scored summary'
complete -c crisismode -n '__fish_use_subcommand' -a diagnose    -d 'Health check and AI diagnosis (read-only)'
complete -c crisismode -n '__fish_use_subcommand' -a recover     -d 'Full recovery flow (dry-run default)'
complete -c crisismode -n '__fish_use_subcommand' -a status      -d 'Quick health probe'
complete -c crisismode -n '__fish_use_subcommand' -a init        -d 'Generate crisismode.yaml or scaffold a plugin'
complete -c crisismode -n '__fish_use_subcommand' -a demo        -d 'Run simulator demo'
complete -c crisismode -n '__fish_use_subcommand' -a webhook     -d 'Start webhook receiver for AlertManager'
complete -c crisismode -n '__fish_use_subcommand' -a ask         -d 'Natural language AI diagnosis'
complete -c crisismode -n '__fish_use_subcommand' -a watch       -d 'Continuous shadow observation'
complete -c crisismode -n '__fish_use_subcommand' -a completions -d 'Print shell completion script'

# Global flags
complete -c crisismode -l config   -d 'Path to crisismode.yaml' -r -F
complete -c crisismode -l target   -d 'Target name from config' -r
complete -c crisismode -l json     -d 'Machine-readable JSON output'
complete -c crisismode -l no-color -d 'Disable colored output'
complete -c crisismode -l verbose  -d 'Show additional detail'
complete -c crisismode -s h -l help    -d 'Show help'
complete -c crisismode -s v -l version -d 'Show version'

# scan
complete -c crisismode -n '__fish_seen_subcommand_from scan' -l category -d 'Comma-separated service kinds to scan' -r

# recover
complete -c crisismode -n '__fish_seen_subcommand_from recover' -l execute     -d 'Enable mutations'
complete -c crisismode -n '__fish_seen_subcommand_from recover' -l health-only -d 'Health check only, no diagnosis'

# init
complete -c crisismode -n '__fish_seen_subcommand_from init' -l agent -d 'Scaffold a new check plugin' -r

# webhook
complete -c crisismode -n '__fish_seen_subcommand_from webhook' -l execute -d 'Enable mutations'

# watch
complete -c crisismode -n '__fish_seen_subcommand_from watch' -l interval -d 'Poll interval in seconds' -r

# completions
complete -c crisismode -n '__fish_seen_subcommand_from completions' -a 'bash zsh fish' -d 'Target shell'
`.trimStart();

const SHELLS = new Set(['bash', 'zsh', 'fish'] as const);
type Shell = 'bash' | 'zsh' | 'fish';

const COMPLETION_SCRIPTS: Record<Shell, string> = {
  bash: BASH_COMPLETION,
  zsh: ZSH_COMPLETION,
  fish: FISH_COMPLETION,
};

export async function runCompletions(shell: string): Promise<void> {
  if (!SHELLS.has(shell as Shell)) {
    process.stderr.write(`crisismode completions: unsupported shell "${shell}"\n`);
    process.stderr.write('Supported shells: bash, zsh, fish\n');
    process.stderr.write('\nUsage:\n');
    process.stderr.write('  crisismode completions bash   # Bash\n');
    process.stderr.write('  crisismode completions zsh    # Zsh\n');
    process.stderr.write('  crisismode completions fish   # Fish\n');
    process.exit(1);
  }

  process.stdout.write(COMPLETION_SCRIPTS[shell as Shell]);
}
