# Security Policy

## Supported Versions

| Version | Status |
|---------|--------|
| 0.3.x   | ✅ Supported |
| < 0.3   | ❌ Not Supported |

## Reporting a Vulnerability

We take security vulnerabilities seriously. If you discover a security issue in cubrid-client, please report it responsibly by emailing:

**Email:** paikend@gmail.com

**Do not** open a public GitHub issue for security vulnerabilities. Responsible disclosure allows us to address the issue before public disclosure.

### Response Timeline

- **48 hours:** Initial acknowledgment of your report
- **7 days:** Security assessment and initial response with remediation plan
- **Ongoing:** Regular updates on progress until resolution

## What Qualifies as a Security Issue

A security issue is any vulnerability that could:

- Allow unauthorized access to data
- Permit SQL injection or other code execution attacks
- Expose sensitive information (credentials, tokens, private data)
- Compromise confidentiality, integrity, or availability of the system

Examples include:
- SQL injection vulnerabilities in query construction
- Authentication/authorization flaws
- Insecure credential handling
- Buffer overflow or memory safety issues

## Dependency Audit Policy

`npm audit --audit-level=high` runs on every pull request, on pushes to `main`, weekly, and on the exact tag before an npm release.

- **Scope:** all dependencies, including `devDependencies`. The package has no runtime dependencies, so a production-only audit would always pass, and the build tools produce the published files.
- **Effect:** a high or critical finding fails the check and stops a release. Moderate and low findings are reviewed through Dependabot and do not fail it.
- **Failures:** npm exits non-zero when the audit service cannot be reached. Treat that as "not audited" and rerun the check.
- **Exceptions:** no overrides for high or critical findings. Remediate or stop publication; document any risk and planned mitigation without bypassing the failing audit gate.

## Security Best Practices for Users

When using cubrid-client, follow these security best practices:

- Always use parameterized queries to prevent SQL injection. `query()` and
  `execute()` render the values into the SQL text as escaped literals, and refuse
  a value or a value count they cannot place safely (see
  [Sending JavaScript parameters](docs/TYPES.md#sending-javascript-parameters)).
  `queryPrepared()`, `queryResultPrepared()` and `executePrepared()` send the
  values as typed binds, so no value ever becomes SQL text
- Never build identifiers or SQL text from untrusted input: values are the only
  safe input
- Keep cubrid-client updated to the latest version
- Use secure connection parameters when connecting to CUBRID databases
- Follow the principle of least privilege for database credentials
- Never hardcode credentials in your application code
- Use environment variables or secure credential management systems

## Disclosure Policy

Once a security vulnerability is fixed:

1. A security patch will be released
2. The vulnerability will be disclosed in release notes
3. Credit will be given to the reporter (if requested)

We appreciate your responsible disclosure and help in keeping cubrid-client secure.
