# pi-toilgate

A [Pi coding agent](https://pi.dev) extension that adds toilgate as a model provider. Sign in once with Google and pick any toilgate model directly from Pi's model selector.

## Install

### Manual

Clone the repo and copy the extension to Pi's global extensions directory:

```bash
git clone https://github.com/welteki/pi-toilgate.git
cp pi-toilgate/toilgate.ts ~/.pi/agent/extensions/
```

### Via settings.json

Add the repo to the `packages` list in `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "git:github.com/welteki/pi-toilgate@main"
  ]
}
```

Pi will fetch and load the extension automatically on next launch.

## Bot Token (non-interactive)

If you have client credentials from your toilgate server, set them as environment variables and skip Google sign-in entirely:

```bash
export TOILGATE_CLIENT_ID=pi_provider
export TOILGATE_CLIENT_SECRET=...your-secret...
```

Pi will use the OAuth 2.0 client credentials grant to obtain an access token automatically.
No browser interaction is needed — this works perfectly in CI, SSH, and headless environments.

## Sign in (Google OAuth)

Run `/login` inside Pi and select **toilgate**, then follow the prompts to sign in with Google.

- **Local machine:** a browser window opens to complete sign-in.
- **SSH or headless:** a device code is shown instead — open the link on any device and confirm the code.

Your credentials are saved and refreshed automatically, so you only need to sign in once.

## Configuration (Google OAuth)

When using Google OAuth (no client credentials set), configure:

Set `TOILGATE_URL` in your shell environment before starting Pi:

```bash
export TOILGATE_URL=https://your-toilgate-server.example.com
```

Or pass it inline:

```bash
TOILGATE_URL=https://your-toilgate-server.example.com pi
```
