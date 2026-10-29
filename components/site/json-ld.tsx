/** Structured data for search engines. React writes script text unescaped, and every less-than sign is escaped so content can never close the tag. A JSON block is data, so the nonce CSP does not apply. */
export function JsonLd({ data }: { data: object | object[] }) {
  return <script type="application/ld+json">{JSON.stringify(data).replace(/</g, "\\u003c")}</script>;
}
