import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Old static-site URLs (e.g. shared links to Shop.html) keep working.
  async redirects() {
    return [
      { source: "/SpiritDrop.html", destination: "/", permanent: true },
      { source: "/Shop.html", destination: "/shop", permanent: true },
      { source: "/Product.html", destination: "/product", permanent: true },
      { source: "/Delivery.html", destination: "/delivery", permanent: true },
      { source: "/About.html", destination: "/about", permanent: true },
      { source: "/Contact.html", destination: "/contact", permanent: true },
      { source: "/Legal.html", destination: "/legal", permanent: true },
    ];
  },
};

export default nextConfig;
