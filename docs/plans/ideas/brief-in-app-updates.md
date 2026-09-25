# Brief — In-App Updates

**Status:** Idea / design only (2026-09-21). No ADR, no build plan, no owner
approval. Written at owner request after a release-versioning discussion the
same evening.

**Kind:** Brief / design doc (documentation-policy Rule 3). Investigation
journal: `.research/2026-09-21-in-app-updates-brief.md`.

---

## 1. The problem, in the owner's words

> "People who want to use Litria have to wait for us to build, test and release.
> Is there a way for people to not have to uninstall what they have, but just
> update through the app and it grabs whatever is in GitHub, the app just parses
> the diff and installs what's missing?"

Today a Litria user updates like this: notice a release exists (somehow), open
GitHub, find the right asset for their platform, download ~190 MB, run the
installer, click through it. Nothing in the app tells them an update exists.

The goal is: the app tells them, and one click does the rest.

## 2. Correcting the model up front: there is no diff

Tauri v2's updater performs a **full bundle replace**. It downloads the entire
new application archive, verifies a signature, swaps the installed files in
place, and relaunches. It does not compute a diff, and it does not fetch only
changed files.

Delta/patch updating is a real technique — Sparkle on macOS, MSIX on Windows,
Chrome's Courgette — but it is **not available in this stack**. Any design here
is "download all of it again, but without the user doing the work."

This single fact governs the whole brief, because of section 3.

> **Unverified (2026-09-21):** the Tauri-specific claims in this brief were
> written from model knowledge, not checked against Tauri's primary docs during
> this session. Slice 0 exists to verify them before anything is built. Config
> key names in particular should be treated as indicative, not exact.

## 3. The decision the owner actually has to make

**Litria's bundle is large.** `npm run bundle` stages Node, the language
servers, and the sideloaded ConPTY pair before any release build
(release-policy Rule 2). Memory records roughly **4 MB host / ~190 MB total** as
the v1.0.5 baseline — approximate and not re-measured for 1.0.9.

Combined with section 2, that means:

> **Every update, including a one-line patch, downloads the entire ~190 MB
> application.**

That is the trade. It is not a technical blocker — it is a product decision, and
it is the owner's to make. The options:

| Option | What it means | Cost |
|---|---|---|
| **A. Update everything, every release** | Simplest. Matches how the updater is designed to work. | ~190 MB per release, per user. Nine releases since the flip would have been ~1.7 GB. |
| **B. Update only on minor/major** | Patches stay manual; feature releases prompt. | Fewer downloads, but the users who most need a bugfix are the ones who don't get it. Undermines the point. |
| **C. Prompt always, download deliberately** | App always tells you an update exists and what changed; the download is a separate, explicit click showing the size. | Same bytes as A, but the user chooses knowingly. Recommended. |
| **D. Split the payload (future)** | Ship the ~4 MB host separately from the ~186 MB runtimes, update only what changed. | Not supported by the Tauri updater. Would be a bespoke system. Out of scope; noted so the door stays open. |

**Recommendation: C.** It preserves the real win (users learn an update exists
and never touch an installer), it is honest about the cost at the moment the
cost is paid, and it satisfies the security posture in section 6 — which forbids
silent downloads anyway.

Option D is worth a sentence of foresight: if the bundled runtimes were ever
versioned and fetched separately from the app shell, most updates would become
small. That is a large arc of its own and should not be smuggled into this one.

## 4. What exists today

Verified against the tree at 1.0.9 (`main`, 2026-09-21):

- **Nothing.** No updater plugin in `src-tauri/Cargo.toml` or `package.json`, no
  `plugins` key in `src-tauri/tauri.conf.json`, no updater artifacts, no signing
  key in CI. This is greenfield.
- **`.github/workflows/release.yml`** builds a 4-target matrix
  (`linux-x86_64`, `macos-aarch64`, `macos-x86_64` cross-compiled,
  `windows-x86_64`), then each job independently runs
  `gh release upload ... --clobber`.
- Artifacts are **unsigned at the OS level on every platform** (RELEASE_NOTES
  v1.0.8 platform-status banner).

### 4.1 Two concrete blockers already identified

These are not generic caveats; they are specific to this repo and each would
cost a debugging session if discovered during implementation instead of now.

**Blocker 1 — the CSP blocks the update check.**
`src-tauri/tauri.conf.json` sets production `connect-src` to
`'self' ipc: http://ipc.localhost`. There is no external origin. A fetch to a
GitHub-hosted manifest fails under this policy. The CSP must gain a narrowly
scoped origin, and that change is itself a security review item (section 6).

**Blocker 2 — the artifact glob would drop updater artifacts.**
The "Collect artifacts" step matches only
`*.dmg *.AppImage *.deb *.rpm *-setup.exe *.msi`. Updater bundles
(`.tar.gz` / `.zip`) and their detached `.sig` files match none of these and
would be silently left behind — producing a release that looks complete and an
update that can never resolve.

### 4.2 A structural gap: nothing aggregates the matrix

The update manifest (`latest.json`) names the download URL and signature for
**every** platform. No single matrix job can write it, because each job only
knows its own artifact. This needs a **new job with `needs: build`** that runs
after all four.

That interacts with `fail-fast: false`, which is deliberately set so "one
platform failing must not deny the others their artifacts." Correct for
installers; hazardous for a manifest. **The aggregation job must refuse to
publish a manifest naming an artifact that was never uploaded** — otherwise a
partial release hands some users a broken update.

## 5. The part that makes this more reachable than it looks

The Tauri updater requires its own signature, generated from a **minisign**
keypair (`tauri signer generate`). This is Litria's own key and is
**independent of OS code signing** — Apple Developer ID, Windows Authenticode.

If that holds (Q4, to be verified in slice 0), then:

- Litria can ship working in-app updates **without** buying an Apple developer
  account or a Windows certificate.
- SmartScreen and Gatekeeper warnings stay exactly as they are today — no
  better, no worse. In-app updating does not improve the install-time trust
  story, and the brief should not be read as claiming it does.

## 6. Security posture

Loaded per AGENTS.md §2: this creates **both** a new network surface and a new
execution surface, so security-policy Rule 1 triggers twice. A security review
is mandatory before this ships.

**Classification** (security-policy Rule 2, class 1 — verified artifact): the
downloaded bundle is a pinned artifact from an official distributor, verified
before use. The distinguishing feature here is that the "third party" is Litria
itself, so **the minisign private key becomes a trust root for every installed
copy of the app.** Compromise of that key is compromise of every user.

Design constraints that follow:

- **No silent downloads, ever** (standing trust rule). The update is offered,
  never applied in the background. This is the policy reason option C in
  section 3 is also the recommended product answer.
- **Signature verification is not optional and must not be bypassable.** A
  failed verification is a refusal the user sees (Rule 4: refusals must be
  visible), not a silent fallback to installing anyway.
- **Key custody needs a written answer** before the first signed release: where
  the private key lives, who can use it, what happens if it leaks, and whether
  it goes in the existing locker. `TAURI_SIGNING_PRIVATE_KEY` as a repo secret
  is the mechanism, not the policy.
- **CSP widening is part of the review**, not an incidental edit. Scope the new
  origin as narrowly as the update host allows.
- **Chokepoint note** (security-policy Rule 4): the updater writes to the
  install directory entirely outside the filesystem write manager. That is
  legitimate — it is not user content — but it should be **recorded as a
  deliberate out-of-scope path** rather than left as an unregistered bypass, so
  a future rule added at the manager is not silently assumed to cover it.

**Residual risk, named alongside the mitigation** (Rule 2): signed updates prove
the bundle came from whoever holds the key. They prove nothing about whether the
build was correct, and they do not protect against a compromised key or a
compromised release pipeline. Reproducible builds and build fingerprinting
(`docs/security-audits/OSS-security-prd.md`) are the answer to that class, and
they are out of scope here.

## 7. How this interacts with the 1.x → 2.0 ladder

From the owner ruling the same evening: **2.0 is reserved for Teams/sync**,
which carries the piece-identity schema change; everything before it is minor or
patch, with a yield clause if a compatibility break lands earlier.

The update manifest is a file Litria controls, which means **the app can decide
what each user is offered**. That produces a lever that does not exist today:

- 1.x users can be held at the last 1.x release rather than being walked into a
  build that rewrites their canvases.
- A major-version update can be presented differently from a patch — with the
  migration explained before anything is downloaded.

This is a real argument for building the updater **before** 2.0 rather than
after. Shipping a schema break to a population that has no update channel, and
then asking them to manually find the right installer, is the bad version of
that day.

It is worth being blunt about a related risk: a one-click update path makes it
*easier* to push a breaking change to everyone at once. The versioning ladder
and the migration discipline are what keep that from being a footgun. The
updater does not create that obligation, but it raises the cost of getting it
wrong.

## 8. What this does *not* solve

Stated plainly because the original question framed it as a fix for release
latency:

- **It does not remove any of our work.** We still bundle, still build four
  targets, still test, still tag, still publish. Users still wait for that.
- **It removes the user's fetch step**, not ours. That is the whole win, and it
  is worth having — but the release cadence is unchanged.
- It does not improve install-time trust warnings (section 5).
- It does not reduce download size (sections 2–3).

## 9. Proposed slices

Not approved; sequencing only, for an eventual build plan.

**Slice 0 — Verify the premises.** Confirm against Tauri's primary docs: exact
v2 config keys, that minisign is genuinely independent of OS code signing (Q4),
how the updater interacts with the bundled runtimes staged by `npm run bundle`
(Q5), and the true per-platform installer size (Q1). Cheap, and every later
slice depends on it. If minisign turns out to be entangled with OS signing, the
arc changes shape and should be re-scoped before slice 1.

**Slice 1 — Key custody + security review.** Generate the keypair, decide
custody, write the review entry. Before any code.

**Slice 2 — Plugin + config.** Add the updater plugin, the `plugins.updater`
block, `createUpdaterArtifacts`, and the narrowed CSP origin. Prove the app
still builds and the guards still pass.

**Slice 3 — CI: artifacts + manifest.** Widen the collection glob (blocker 2),
add the `needs: build` aggregation job (section 4.2) with the partial-release
refusal, wire `TAURI_SIGNING_PRIVATE_KEY`.

**Slice 4 — In-app UX.** Check-on-demand first (a menu item), not
check-on-launch. Show version, what changed, and **the download size** before
the download. A preference in `src/preferences/registry.js` governs whether the
app checks automatically at all; default should be decided deliberately, not by
whatever the plugin defaults to.

**Slice 5 — Live verification.** A real update applied to a real prior install,
per platform, by a human. Given the platform-status banner, Windows is the only
one with standing evidence today; macOS and Linux inherit the usual caveat.

## 10. Open questions

- **Q1** — Actual installer size per platform at 1.0.9. The ~190 MB figure is a
  v1.0.5 memory baseline and is stale. Section 3's decision deserves a real
  number.
- **Q4** — Are the Tauri v2 config keys as named here, and is minisign truly
  decoupled from OS code signing? Load-bearing for section 5.
- **Q5** — Does the in-place replace interact badly with the bundled runtimes,
  the sideloaded ConPTY pair, or a running language server? An update applied
  while `rust-analyzer` is live is worth thinking about before it is worth
  testing.
- **Q6** — Should a user on 1.x ever be offered 2.0 automatically, or should a
  major version require a deliberate opt-in? (Section 7.)
- **Q7** — Auto-check on launch: on or off by default? Off is the conservative
  read of "no silent downloads" — though a *check* is not a *download*, and the
  distinction should be made explicitly rather than assumed.

## 11. Recommendation

Worth doing, and worth doing before 2.0 — but as a proper arc with a security
review, not as a quick config change. The two blockers in 4.1 and the
aggregation gap in 4.2 are the kind of thing that turns "an afternoon" into
three evenings if they are met one at a time during implementation.

The decision that gates everything else is section 3: **is ~190 MB per update
acceptable?** If the answer is no, this arc should wait for a payload-splitting
design rather than shipping something users learn to dismiss.
