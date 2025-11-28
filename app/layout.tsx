import React from 'react';

export const metadata = {
  title: 'Bordados do Sr. Lucas - Atelier Digital',
  description: 'Run and deploy your AI Studio app',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <script src="https://cdn.tailwindcss.com"></script>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&family=Playfair+Display:ital,wght@0,400;0,600;1,400&display=swap" rel="stylesheet" />
        <style>{`
          body {
            font-family: 'Inter', sans-serif;
            background-color: #FDFBF7; /* Warm art paper */
            color: #1C1C1C; /* Soft black */
          }
          h1, h2, h3, .serif {
            font-family: 'Playfair Display', serif;
          }
          
          /* Custom Scrollbar for the sidebar */
          ::-webkit-scrollbar {
            width: 6px;
          }
          ::-webkit-scrollbar-track {
            background: transparent;
          }
          ::-webkit-scrollbar-thumb {
            background: #E8E6E2;
            border-radius: 3px;
          }
          ::-webkit-scrollbar-thumb:hover {
            background: #D1CEC7;
          }
        `}</style>
      </head>
      <body>{children}</body>
    </html>
  );
}
