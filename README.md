# MediaForest

Personal media library application. Browse, search, scan, and track your media library — share it with trusted friends via a peer-to-peer signed feed.

## Getting Started

### First user (owner setup)

Open MediaForest in your browser. With no users registered, the page shows "Set up this server — create your owner account."

1. Enter a **name** (optional)
2. Enter a **passphrase** — this becomes your identity key. It never leaves your browser.
3. Enter a **password** — this lets you log in from any device without needing the companion app, and serves as your account recovery key. Minimum 8 characters. **Strongly recommended.**
4. Click **Create Account**

### Signing in

**Best way (any device where the companion is installed):** The companion app detects MediaForest automatically and signs you in with no passphrase prompt.

**From a new device or browser:** Click "Sign in with password" and enter the password you set during registration.

**Passphrase fallback:** If you remember your passphrase but don't have the companion, enter it directly.

### Open vs. closed registration

By default, a MediaForest server starts in **open mode**, which allows other users to register and use the server as a relay node. They will never have access to your config or media unless you explicitly share it with them.

For higher security, switch to **closed mode** in Settings → Server Access. In closed mode, new registrations require an invite token you generate.

### Adding users (as owner)

Click **+ Invite** in the header to generate a one-time invite token (7-day expiry). Share the token with the person you want to add. They open the login page and click "Have an invite? Register →".

### Companion app (optional but recommended)

The companion is a small app that runs on your device and holds your identity key. Once running, MediaForest detects it and logs you in automatically — no passphrase or password needed on that device.

- Install: [github.com/christcb03/phrasevault#local-auth-agent](https://github.com/christcb03/phrasevault#local-auth-agent)
- Runs on `localhost:8765`
- On first run, it will ask for your server URL and register your account

### Importing from Plex

Go to Settings → Plex Media Server and enter your Plex server URL and token. Then click **🟠 Plex** in the toolbar to import your Plex library and sync watch status.

---

## Auth model

- Each user's identity is a `secp256k1` keypair. With the companion, the key is stored in the companion. Without it, the key is derived from your passphrase via BLAKE3.
- Passwords are stored as `argon2id` hashes. Password login is non-destructive — it issues a session token without touching your identity key.
- The first user to register becomes the owner.
- Sessions expire after 24 hours.
- Watchlists are per-user. The media library (titles, files, sources) is shared across all users.

## Deployment

See [deploy/DEPLOYMENT.md](deploy/DEPLOYMENT.md).
