# Contributing

Thanks for your interest in improving this reference architecture.

## Reporting issues

Open a GitHub issue with:
- What you expected to happen and what actually happened.
- The `cdk deploy` output or relevant CloudWatch Logs, with any account IDs, ARNs, or hostnames redacted.
- Your CDK version (`cdk --version`) and the region you deployed to.

## Making changes

1. Fork the repo and create a branch for your change.
2. If you're changing CDK code, run `npx tsc --noEmit` and `npx cdk synth --all` in `cdk/` with placeholder context values before opening a PR — a synth failure will fail review immediately.
3. If you're changing the gateway or admin console containers, rebuild and boot-test locally (`docker build`, then run the image and hit `/healthz`) before opening a PR.
4. Keep documentation in `docs/` in sync with any behavioral change — this repo's value is in being followable step by step, so a code change that isn't reflected in the docs is an incomplete PR.
5. Open a pull request describing what changed and why, and how you tested it.

## Security

Please do not open a public GitHub issue for a security vulnerability. See [AWS's vulnerability reporting guidance](https://aws.amazon.com/security/vulnerability-reporting/) instead.

## Code of conduct

Be respectful and constructive. This is a reference implementation maintained on a best-effort basis; not every feature request will fit its scope.
