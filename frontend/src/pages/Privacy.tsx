export default function Privacy() {
  return (
    <div style={{ maxWidth: '700px', margin: '0 auto', padding: '4rem 2rem' }}>
      <h1 style={{
        fontFamily: '"DM Serif Display", Georgia, serif',
        fontSize: '2rem',
        fontWeight: 400,
        color: '#fff',
        margin: '0 0 0.5rem',
      }}>Privacy Policy</h1>
      <p style={{ fontSize: '0.8125rem', color: 'rgba(255,255,255,0.25)', margin: '0 0 3rem' }}>
        Last updated June 2026
      </p>

      <Section title="Overview">
        Veritas is a hackathon project. We do not collect, store, or sell personal
        data. This policy describes what limited information is involved in using
        the application.
      </Section>

      <Section title="Authentication">
        Sign-in is handled by Dynamic Labs and Google OAuth. We receive a JWT
        from Google solely to derive a deterministic Sui address (via the
        zkLogin protocol). The JWT is not stored. Your email address is never
        recorded or transmitted beyond the authentication flow.
      </Section>

      <Section title="On-Chain Activity">
        All predictions, commits, scores, and registrations are submitted to the
        Sui blockchain. On-chain data is public by the nature of a public
        blockchain — anyone can read it. Do not submit information on-chain
        that you wish to keep private.
      </Section>

      <Section title="Cookies & Local Storage">
        Dynamic Labs may store a session token in your browser's local storage
        to keep you connected between visits. No tracking cookies are used.
      </Section>

      <Section title="Contact">
        Questions? Reach us at{' '}
        <a
          href="mailto:zoomfrez01@gmail.com"
          style={{ color: 'rgba(255,255,255,0.6)', textDecoration: 'underline' }}
        >
          zoomfrez01@gmail.com
        </a>
        .
      </Section>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: '2.5rem' }}>
      <h2 style={{
        fontFamily: '"DM Serif Display", Georgia, serif',
        fontSize: '1.1rem',
        fontWeight: 400,
        color: '#fff',
        margin: '0 0 0.75rem',
      }}>{title}</h2>
      <p style={{
        fontSize: '0.9rem',
        color: 'rgba(255,255,255,0.55)',
        lineHeight: 1.7,
        margin: 0,
      }}>{children}</p>
    </div>
  )
}
