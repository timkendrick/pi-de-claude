# pi-de-claude

pi-de-claude connects the pi coding agent to any IDE running the Claude Code plugin-including VS Code, Neovim, IntelliJ IDEA, and other JetBrains IDEs. It lets the LLM interact with your IDE for operations like diff view/approval and lets you reference code from your IDE in your conversations with pi.

<img width="2012" height="266" alt="89481" src="https://github.com/user-attachments/assets/eea1fc66-544b-41e2-9d29-234522399220" />

## Why use this extension?
- Let pi trigger IDE actions (open files, diffs etc).
- Code that you highlight in the IDE is available to pi.

## Installation
```sh
# Install from npm
pi install npm:@lukebarton/pi-de-claude

# Or from git
pi install github.com/lukebarton/pi-de-claude
```
## IDE Plugins
- Claude Code plugin installed in your IDE
    - [Claude Code for VS Code](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code)
    - [Claude Code for JetBrains](https://plugins.jetbrains.com/plugin/27310-claude-code-beta-)
    - [claudecode.nvim](https://github.com/coder/claudecode.nvim)

<img width="2036" height="822" alt="62003" src="https://github.com/user-attachments/assets/567df5b2-1425-4728-9238-9314d9a866b6" />


## Using pi-de-claude
1. **Connect:** Run the `/ide` command inside pi. Choose the IDE you want if more than one is detected.
2. **Use it:**
   - When pi suggests edits, it will present a diff inside your IDE for approval.
   - Highlight code in your IDE to give pi immediate context for your next request.

### A quick note about ever fallible LLMs
LLMs are still LLMs will forget to call the IDE tools. You can improve your chances by asking for it directly (for example, "use `openDiff` to show the changes"). You can see the list of available tools by running `/ide` and reviewing the tool descriptions.

## Issues
- cc plugin at-mentions don't get sent to pi
  - JetBrains: No workaround - the cc plugin sends at-mentions directly to the self-managed console, rather than over the Websocket API
  - VS Code: `"claudeCode.useTerminal": true` forces them over the WebSocket API

## The future and commentary
- I'm happy to maintain this extension in the face of API changes, but the IDE plugins are maintained by Anthropic, and they don't seem to get much love. Who knows what Anthropic has in mind for the future of these plugins.
- Anthropic may try to poo-poo piggyback integrations like this with extra protocol hoops to defend their moat. I haven't got the time or desire to chase them around on that, so this extension will work while it's easy.
- We could be better off building some kind of open source, open host, community-led, cross-IDE integration for LLM coding agents in general. 
  - [pi-de](https://github.com/pierre-borckmans/pide) is an example of going home-grown, but only supports IDE->pi code references (no diffs), hence why I thought this extension might be more useful.
  - Trying to achieve more than a basic set of features across all IDE integrations feels like it'd be an uphill battle.
  - This kind of open-host integration point for IDEs could be useful in many ways for the big LLM providers and IDE developers too, but I doubt they'll give up building their moats any time soon.
- Patches welcome.

### References
- Unarchiving the JetBrains plugin to see how it uses the API - though the JB plugin is using an older (but mostly compatible) protocol version.
  - nb. The VS Code plugin is obfuscated by minification.
- [How Claude Code IDE Extensions Actually Work](https://github.com/coder/claudecode.nvim/blob/main/PROTOCOL.md) is a useful reference.
