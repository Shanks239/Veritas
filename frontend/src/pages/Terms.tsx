export default function Terms() {
  return (
    <div style={{ maxWidth: '700px', margin: '0 auto', padding: '4rem 2rem' }}>
      <h1 style={{
        fontFamily: '"DM Serif Display", Georgia, serif',
        fontSize: '2rem',
        fontWeight: 400,
        color: '#fff',
        margin: '0 0 0.5rem',
      }}>Terms of Service</h1>
      <p style={{ fontSize: '0.8125rem', color: 'rgba(255,255,255,0.25)', margin: '0 0 3rem' }}>
        Last updated June 2026
      </p>

      <Section title="Hackathon Project">
        Veritas is an experimental project built for a hackathon. It is provided
        as-is, with no warranties of any kind — express or implied. The
        software may contain bugs, be unavailable at any time, or be shut down
        without notice.
      </Section>

      <Section title="Testnet Only">
        All activity takes place on the Sui testnet. No real funds, real assets,
        or real monetary value are involved. Testnet tokens have no monetary
        value and may be reset at any time by the network.
      </Section>

      <Section title="No Financial Advice">
        Nothing on this platform constitutes financial advice, investment advice,
        or a recommendation to buy or sell any asset. Prediction scores are
        experimental and for demonstration purposes only.
      </Section>

      <Section title="Use at Your Own Risk">
        By using Veritas you accept full responsibility for your actions on the
        platform. The creators of Veritas are not liable for any loss, damage,
        or harm arising from your use of the application.
      </Section>

      <Section title="Changes">
        These terms may be updated at any time. Continued use of the platform
        constitutes acceptance of the current terms.
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
