// Test preload (node --import): sends requests to https://api.github.com to a local fake server
// (ADISPATCH_TEST_GITHUB_URL), so that real child processes can run against Fake-GitHub.
const target = process.env.ADISPATCH_TEST_GITHUB_URL;
if (target) {
  const real = globalThis.fetch;
  const origin = 'https://api.github.com';
  globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(origin)) return real(target + url.slice(origin.length), init);
    return real(input, init);
  };
}
