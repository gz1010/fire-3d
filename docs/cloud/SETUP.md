# Running a Fire-3d build in a Claude Code cloud session

A cloud session runs on Anthropic's machines, so you can close your Mac. It copies the project from the private GitHub repository `gz1010/fire-3d`. You check on it from claude.ai/code or the Claude app's Code tab.

## One-time setup (about 10 minutes)

### 1. Let Claude reach the repository

Open https://github.com/apps/claude and choose **Install** (or **Configure** if you installed it before). Under "Repository access", pick **Only select repositories**, choose **fire-3d**, and save.

### 2. Create a cloud environment for Fire-3d

Go to https://claude.ai/code, open the environment selector and create a new environment named **Fire-3d**, or edit **Default**. Set:

- **Network access: Full.** Fire-3d downloads from about 20 public data services (USGS, LANDFIRE, NASA, NOAA/NWS, Open-Meteo, NIFC, CAL FIRE, Census, map tiles…). The default "Trusted" level blocks them.
- **Environment variables.** Type your real NASA FIRMS key here, and never paste it into a chat:
  ```text
  FIRMS_MAP_KEY=your-key-here
  BASH_DEFAULT_TIMEOUT_MS=300000
  BASH_MAX_TIMEOUT_MS=1800000
  ```
  The key can't be a "network secret", because NASA FIRMS expects it inside the web address rather than in a request header. Only you can see this environment.
- **Setup script.** Paste the whole contents of `docs/cloud/environment-setup.sh`. It installs Python 3.12 and Chrome for screenshots.

### 3. Make the terminal use that environment

In Claude Code on your Mac, type `/remote-env` and pick **Fire-3d**.

## Start the build

In a terminal, in the Fire-3d folder:

```bash
claude --cloud "Follow docs/redesign/RUNBOOK-3.md to build brief 3 (fires across the lower 48 states) end to end."
```

The terminal shows a short setup checklist and then a link to the session. You can close your Mac after that.

## While it runs

- **Watch or reply** at claude.ai/code, or in the Claude app under **Code**.
- **Usage limits:** if a message says you've hit your usage limit, reply "continue" after the reset time shown.
- **Expected time:** about 10-16 hours of work. The cloud machine has 4 CPU cores and no graphics card, so fewer agents run at once and the 3D frame-rate checks are skipped.

## When it's done

The session pushes its work to a branch on GitHub and posts a summary. Back on your Mac, either:
- ask Claude to merge the cloud branch into your local copy, or
- run `claude --teleport` to continue that session locally.

Fire data built in the cloud (`data/`) stays in the cloud. Fires you open locally are prepared again on your Mac when you press "Prepare analysis".
