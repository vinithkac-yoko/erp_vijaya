# Putting Vijaya Stores on Railway — click by click

You do this once. It takes about 15 minutes. Railway rebuilds the app every time we push to the branch you pick in step 3.

You need: a Railway account (railway.com), and this GitHub repo (`vinithkac-yoko/erp_vijaya`).
Do **not** use the Railway command-line tool. Everything below is in the browser.

## 1. Make a project from the repo

1. Open **railway.com** and log in.
2. Click **New Project**.
3. Click **Deploy from GitHub repo**.
4. If Railway asks to connect GitHub, click **Configure GitHub App**, allow it to see `erp_vijaya`, and come back.
5. Click **erp_vijaya**. Railway makes a service and starts a first build. **It will fail or wait for settings. That is fine.** Carry on.

## 2. Add the database

1. In the project, click **+ New** (top right) → **Database** → **Add PostgreSQL**.
2. Wait until the new Postgres box turns green.

## 3. Pick the branch

1. Click the **erp_vijaya** service box → **Settings** tab → **Source**.
2. **Branch connected to production**: choose **`main`** once the first pull request is merged.
   Until then choose **`claude/great-noether-62113h`** (the branch that has the app).
3. Leave **Root Directory** empty. Railway reads `railway.json` from the repo and uses it for the build,
   the start command and the health check.

## 4. Set the variables

Click the **erp_vijaya** service → **Variables** tab → **New Variable**, and add these one by one
(use **Raw Editor** to paste them all at once if you prefer).

| Name | Value | Why |
|---|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | Links the app to the database you added. Type it exactly, with the braces. |
| `SESSION_SECRET` | 40 or more random letters and numbers | Locks the login cookies. Keep it private. Changing it signs everyone out. |
| `APP_URL` | the web address from step 5, e.g. `https://vijaya-stores-production.up.railway.app` | Used in links. Add it after step 5. |
| `SEED_OWNER_NAME` | the owner's name, e.g. `Mr. Vijay` | Shown in the app |
| `SEED_OWNER_EMAIL` | the owner's email | He logs in with this |
| `SEED_OWNER_PASSWORD` | a password of 10+ characters | **Recommended.** You choose it, so it never lands in a log |
| `SEED_STOREKEEPER_NAME` | the storekeeper's name | Shown in the app |
| `SEED_STOREKEEPER_EMAIL` | the storekeeper's email | He logs in with this |
| `SEED_STOREKEEPER_PASSWORD` | a password of 10+ characters | Same as above |

Good to know:
- The `SEED_*` variables are read **only the first time**, when the database has no users. After that, changing them does nothing.
- If you leave a password out, the app makes a strong one and prints it **once** in the deploy log
  (Deployments → the latest one → **Deploy Logs**, look for `FIRST PASSWORDS`). Copy it then.
- Later milestones add `DEMO_MODE`, `UPLOAD_DIR` and, if the owner wants emails, `SMTP_URL` and `NOTIFY_FROM`. Not needed yet.

**The assistant (milestone 3).** Without a key the app still works: the buttons, the opening card and everything else run, and the chat box says the assistant is off.

| Name | Value | Why |
|---|---|---|
| `ANTHROPIC_API_KEY` | the key from console.anthropic.com | Lets the assistant answer. Keep it private. |
| `ANTHROPIC_MODEL` | optional, default `claude-sonnet-5-5` | Which model answers |
| `ANTHROPIC_EFFORT` | optional, `low`, `medium` (default) or `high` | How hard it thinks. Higher is slower and costs more. |
| `AGENT_ENABLED` | optional, `false` to switch the assistant off for everyone | The kill switch. The owner can also switch it off from the chat (a Setting). Either one turns it off. |
| `AGENT_DAILY_TOKENS` | optional, default `500000` | Most one person can use in a day. After that the assistant says so; the buttons keep working. |
| `AGENT_MESSAGES_PER_MINUTE` | optional, default `20` | Most messages one person can send in a minute |
| `ANTHROPIC_REFUSAL_FALLBACK` | optional, `off` to turn off the automatic fallback when the model declines | Leave it as it is unless Anthropic's support says otherwise |

## 5. Get the web address

1. Service → **Settings** → **Networking** → **Generate Domain**.
2. Copy the address. Put it in `APP_URL` (step 4).

## 6. Deploy and check

1. Service → **Deployments**. If a build is not running, click **Deploy** (or the three dots → **Redeploy**).
2. Wait for **Active** (green). The first build takes a few minutes.
3. Open `your-address/api/health` in the browser. You should see:
   `{"ok":true,"config":"ok","database":"ok","guards":{"expected":33,"missing":[]}}`
   (the number is how many database protections the app checked; `"missing":[]` must be empty)
4. Open `your-address`. You should land on **Log in**. Log in as the owner, then (in another browser or a
   private window) as the storekeeper.

## If something is wrong

| You see | It means | Do this |
|---|---|---|
| Deployment says **Failed** at health check | The app started but `/api/health` is not ok | Open `/api/health` or the Deploy Logs. `"config":{"missing":[…]}` names the variable to fix |
| `"database":"down"` | `DATABASE_URL` is wrong | Check it is exactly `${{Postgres.DATABASE_URL}}` and the Postgres box is green |
| The deploy log says `Refusing to start: the database is missing these guards` | The database protections are not all there | Redeploy (the start command re-applies them). If it still says so, someone changed the database by hand; tell us which guard it names |
| Log in says "email or password is not right" | Wrong details, or the seed ran with other emails | Check the `SEED_*` values you set **before the first deploy**. Once users exist, ask us to add a way to reset |
| "Too many tries" | 5 wrong logins from one place | Wait 15 minutes |

## What this does not do yet

- **No volume.** Attachments arrive in a later milestone; we will add a volume at `/data` then.
- **No custom domain.** Railway's address is fine for testing; a custom domain can be added in Settings → Networking.
- Railway will redeploy on every push to the branch. If you want to pause that, Settings → Source → **Disconnect**.
