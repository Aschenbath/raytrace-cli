# Cloud sandboxes

A cloud sandbox is the same isolated copy of your project, on RayTrace's
servers, with sessions recorded for your organization at
**[app.raytracer.si](https://app.raytracer.si)**. This is a preview. The
[README](../README.md#cloud-sandboxes) has the short setup. This page covers
what is uploaded, limits, beta invites, and what happens when you are done.

```sh
npm install -g @raytrace-cli/cli
raytrace auth login                    # opens your browser: sign in, or create your account
cd your-project                        # any Git repository
raytrace sandbox create                # uploads it and prints the sandbox id
raytrace connect <sandbox-id> --claude # a terminal in it, with Claude Code running
```

`auth login` prints a short code and opens the sign-in page; approve it there.
If you skip it, `sandbox create` and `connect` ask you to sign in first. With
one sandbox, `connect` needs no id. You can also create a sandbox in the web
dashboard by dropping a project folder on the **Sandboxes** page.

## What is uploaded

The files Git would track (including new files it doesn't ignore), **without**
`.git`, dependencies such as `node_modules`, build output, `.env*` files, private
keys (`.pem`, `.key`, `.p12`, `.pfx`) and common credential files (`.npmrc`,
`.netrc`, `id_rsa`, …). Check for secrets inside other files before you upload.

## Limits

- **Project size:** up to 200 MiB and 20,000 files, each file up to 25 MiB
  (100 MiB once packed). A project over a limit is refused, with the files
  named, and nothing is uploaded; add those files to `.gitignore`.
- **Sandboxes at a time:** Beta 1, Individual 5, Team & Enterprise 20.
  Destroyed ones don't count.
- **Each sandbox:** 2 GB of memory, 2 CPUs, 256 processes, a 512 MB `/tmp`.

## When you are done

`raytrace sandbox stop` keeps the files. `raytrace sandbox destroy` deletes them
and any sign-in made inside, along with the recorded traces. To keep the traces,
use `--keep-traces` (paid plans).

## Connect GitHub

A cloud sandbox can clone, fetch and push GitHub repositories with no GitHub
key inside it. Its git goes to github.com through RayTrace, which opens the
repositories attached to that sandbox with your organization's RayTrace GitHub
App, then records each clone, fetch and push with the sandbox's evidence.

Once per organization, an org admin installs the App and connects it: on the
[account page](https://raytracer.si/account.html), **Connect GitHub**, choose the
repositories on GitHub, then confirm with GitHub's sign-in.

Then, from your repository:

```sh
raytrace sandbox create --connect               # its GitHub origin
raytrace sandbox create --connect --repo acme/app
```

The sandbox gets your files as usual, then `/workspace` becomes a clone of the
repository on the branch `raytrace/<8 characters of the sandbox id>/work`,
lined up with the commit you have checked out when GitHub has it (else the
branch, else the default branch). Changes you had not committed show as
changes there.

What the agent may do:

- **Fetch and clone** the attached repositories, and any public one.
- **Push** to branches under `raytrace/<8 characters of the sandbox id>/` in an
  attached repository. A push to any other branch, `main` included, is refused,
  and no branch can be deleted. Open the pull request yourself.
- Nothing in a Playground fork: git through RayTrace is off there.

To change what a sandbox may open:

```sh
raytrace sandbox repos <id>                          # list
raytrace sandbox repos <id> --add acme/lib           # attach (the App must be on it)
raytrace sandbox repos <id> --remove acme/lib        # take off; it stops working within a minute
raytrace sandbox repos <id> --add acme/app --connect # attach and make /workspace a clone of it
```

The SDKs do the same: `create({ repo, connect: true })` and `sandbox.repos`
([TypeScript](../sdk/ts/README.md#connect-github),
[Python](../sdk/python/README.md#connect-github)). When git is refused, see
[troubleshooting](troubleshooting.md#git-in-a-connected-sandbox).

## Beta invites

If RayTrace gave you a beta code, sign in, redeem it, then create your sandbox:

```sh
raytrace auth login
raytrace --code <code>
raytrace sandbox create
```

The code gives you one free cloud sandbox for 3 days. Codes are single-use and
expire 3 days after they're issued, and the sandbox's 3 days start when you
redeem it. Inside it, sign in to Claude Code or Codex with your own account:
RayTrace records the session and doesn't provide model access. Your account and that sandbox show as **Beta** in the cloud dashboard
until then.
