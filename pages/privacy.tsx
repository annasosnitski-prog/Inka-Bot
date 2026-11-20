import Head from 'next/head';

export default function Privacy() {
  return (
    <>
      <Head>
        <title>Privacy Policy — Platon Sosnitsky Studio</title>
        <meta name="robots" content="index, follow" />
      </Head>
      <main
        style={{
          maxWidth: 640,
          margin: '0 auto',
          padding: '32px 16px',
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
          color: '#f4f4f5',
          background: '#0c0c0d',
          minHeight: '100vh',
          lineHeight: 1.6,
        }}
      >
        <h1 style={{ fontSize: 22, marginBottom: 16 }}>Privacy Policy</h1>
        <p style={{ color: '#a1a1aa', marginBottom: 16 }}>Last updated: 2026-11-20</p>

        <p style={{ marginBottom: 16 }}>
          This page describes how Platon Sosnitsky Tattoo Studio ("we", "the studio") handles
          information when you contact us through this website or through our Telegram booking
          assistant.
        </p>

        <h2 style={{ fontSize: 17, marginTop: 24, marginBottom: 8 }}>What we collect</h2>
        <p style={{ marginBottom: 16 }}>
          We only process information you voluntarily share with us in chat: your name, contact
          details (such as a Telegram handle, phone number, or Instagram), a description of your
          tattoo idea or placement, and any photos or references you choose to send, in order to
          evaluate your request and schedule a studio appointment.
        </p>

        <h2 style={{ fontSize: 17, marginTop: 24, marginBottom: 8 }}>How we use it</h2>
        <p style={{ marginBottom: 16 }}>
          This information is used solely to discuss your project, provide a price or session
          estimate, and coordinate a booking at the studio. We do not sell or share your data with
          third parties for marketing purposes.
        </p>

        <h2 style={{ fontSize: 17, marginTop: 24, marginBottom: 8 }}>Advertising</h2>
        <p style={{ marginBottom: 16 }}>
          This site may use Google Ads conversion tracking to measure the effectiveness of our
          advertising campaigns. This does not identify you personally; it only records that a
          visitor from an ad clicked through to our booking chat.
        </p>

        <h2 style={{ fontSize: 17, marginTop: 24, marginBottom: 8 }}>Contact</h2>
        <p style={{ marginBottom: 16 }}>
          For any questions about your data, or to request that it be deleted, message us directly
          via{' '}
          <a
            href="https://www.instagram.com/platon_tattoo__/"
            target="_blank"
            rel="noopener"
            style={{ color: '#f4f4f5', textDecoration: 'underline' }}
          >
            Instagram
          </a>{' '}
          or through our Telegram chat.
        </p>

        <p style={{ marginTop: 32 }}>
          <a href="/" style={{ color: '#a1a1aa', textDecoration: 'underline' }}>
            ← Back
          </a>
        </p>
      </main>
    </>
  );
}
