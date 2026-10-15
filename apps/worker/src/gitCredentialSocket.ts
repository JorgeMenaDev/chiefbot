// Where the worker serves git credentials and the helper (gitCredential.ts) asks,
// unless CHIEFBOT_GIT_CREDENTIAL_SOCKET says otherwise. One worker per computer.
export const defaultGitCredentialSocket = "/tmp/chiefbot-git-credential.sock";
