# Set up the GitHub App (one time, about ten minutes)

This replaces the long-lived personal token for everything except creating new repositories. The workforce signs in as a GitHub App, gets a fresh one-hour token for every job, and reaches every repository the App is installed on, including ones you create later. You never edit token scopes again.

Until you do this, nothing changes: the workforce keeps using the `GH_TOKEN` secret. When the App is set up, it takes over and `GH_TOKEN` is used only as a fallback and for creating repositories.

**What the App cannot do.** GitHub does not let an App create a repository on a personal account (that call acts as a person, and an App is not one). So "create a repo called X" still needs a classic `GH_TOKEN` (scopes `repo` and `workflow`). Keep that secret if you want the workforce to create repositories when you ask; it is used for that and nothing else once the App is live. If you never ask for new repositories, you can delete `GH_TOKEN` after the App works.

## Steps

1. On GitHub, click your profile picture, then **Settings**, then **Developer settings** (bottom of the left menu), then **GitHub Apps**, then **New GitHub App**.
2. Name it something like `clear-ops-workforce`. Homepage URL: `https://github.com/drpaulfarrow/clear-ops`. Untick **Webhook, Active** (we do not use webhooks).
3. Under **Repository permissions** set: **Contents**: Read and write. **Pull requests**: Read and write. **Workflows**: Read and write. **Metadata**: Read-only (it is already on). **Issues**: Read and write, only if you want the workforce to use issues. Leave everything else as No access.
4. Under **Where can this GitHub App be installed?** choose **Only on this account**. Click **Create GitHub App**. (If you want the workforce to work on a repository that belongs to an organisation, install the App on that organisation as well, in step 7b: only an organisation owner can approve it.)
5. On the App's page, copy the **App ID** (a number near the top). You will need it in step 9.
6. Scroll to **Private keys** and click **Generate a private key**. A `.pem` file downloads. Keep it private: anyone with it can act as the App.
7. In the left menu click **Install App**, then **Install** next to `drpaulfarrow`. Choose **All repositories** (not "Only select repositories"). This is what makes new repositories work automatically. Click **Install**.
7b. For a repository in an organisation (for example the managed repository `doubleshift`, `shftd2-pre/app-doubleshift`): on the same **Install App** page choose **Install** next to the organisation, and give the App access to that repository (or to all of the organisation's repositories). An organisation owner has to approve it. Nothing in the workforce changes: the App reaches whatever it is installed on.
8. Open the `clear-ops` repository on GitHub, then **Settings**, **Secrets and variables**, **Actions**, **New repository secret**.
9. Add these secrets. GitHub does not allow secret names that start with `GITHUB_`, so these are named `GH_APP_...`; the deploy passes them on to the service. Open the `.pem` file in a text editor, copy everything including the `BEGIN` and `END` lines, and paste it as the value.
   - `GH_APP_ID`: the App ID from step 5.
   - `GH_APP_PRIVATE_KEY`: the whole contents of the `.pem` file.
   - `GH_APP_INSTALLATION_ID`: optional. Leave it out and the service finds the installation on `drpaulfarrow` itself.
10. Open the **Actions** tab in `clear-ops`, pick the latest **ci** run on `main` and click **Re-run all jobs**. When it finishes, the service restarts with the App.
11. Check it: send `/status` to the chief. It should say `GitHub: GitHub App` and list your repositories as reachable. If one is not, the chief also messages you once with what to change (almost always: step 7, choose All repositories).
12. Optional, once you are happy: delete the `.pem` file from your computer. GitHub keeps the App; you can generate a new key any time.

## How it works

- The service signs a short-lived token request with the private key, GitHub returns an installation token valid for one hour, and the service reuses it until five minutes before it expires, then gets a new one.
- Each worker run starts with a fresh token. `git` reads the current token from an owner-only file on the data volume (`DATA_DIR/secrets`, never in a repository), and `gh` runs through a small wrapper that does the same, so even a four hour job never holds an expired token. The token is not put in the environment, a log, an output, a repository or the job store, and workers never receive the private key.
- If the App cannot sign in (a wrong key, say), the service falls back to `GH_TOKEN` if it is set, and tells you once in plain English.
- The App installation covers only what the permissions above allow. It cannot merge past branch protection on `main`, and the existing rules are unchanged: only the maintainer merges, nobody force-pushes or pushes to a default branch.

## If something is wrong

- `/status` says the App is failing: check `GH_APP_ID` and `GH_APP_PRIVATE_KEY` match the App, then re-run the deploy.
- A repository is not reachable: GitHub, Settings, Applications, Installed GitHub Apps, Configure, and choose **All repositories**. If the repository belongs to an organisation, the App has to be installed on that organisation instead: open the organisation's Settings, GitHub Apps, Configure, and give the App access to the repository (an organisation owner approves). The chief's own message names the organisation when that is what is missing.
- Creating a repository fails: that needs the classic `GH_TOKEN` (see the top of this page).
