/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  agentRules: false,
  /*
   * The OG and icon routes read font files from disk at request time. Next's
   * tracer only follows statically analysable imports, so without this the
   * fonts are absent from the deployed bundle and every social card silently
   * falls back to a default face — visible only once the link is already
   * pasted somewhere.
   */
  outputFileTracingIncludes: {
    '/opengraph-image': ['./assets/fonts/**'],
    '/twitter-image': ['./assets/fonts/**'],
  },
};
export default nextConfig;
