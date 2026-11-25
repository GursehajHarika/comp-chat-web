const BRANDS = {
  rogers: {
    id: 'rogers',
    name: 'Rogers',
    color: '#DA291C',
    urls: {
      EN: 'https://www.rogers.com/contact',
      FR: 'https://www.rogers.com/contact?setLanguage=fr'
    },
    selectors: {
      openChat: 'button:has-text("Ask Anna"), button:has-text("Chat"), [aria-label*="chat" i]',
      input: 'textarea, input[type="text"][placeholder*="message" i], input[placeholder*="question" i]',
      send: 'button[type="submit"], button[aria-label*="send" i]',
      messages: '[class*="message"], [class*="bubble"], [role="log"] p'
    }
  },
  bell: {
    id: 'bell',
    name: 'Bell',
    color: '#00549A',
    urls: {
      EN: 'https://support.bell.ca/Contact-us',
      FR: 'https://soutien.bell.ca/Nous-joindre'
    },
    selectors: {
      openChat: 'button:has-text("Chat"), a:has-text("Chat"), [aria-label*="chat" i]',
      input: 'textarea, input[type="text"][placeholder*="message" i]',
      send: 'button[type="submit"], button[aria-label*="send" i]',
      messages: '[class*="message"], [class*="chat-text"], [role="log"] p'
    }
  },
  telus: {
    id: 'telus',
    name: 'Telus',
    color: '#4B286D',
    urls: {
      EN: 'https://www.telus.com/en/support/contact-us',
      FR: 'https://www.telus.com/fr/support/contact-us'
    },
    selectors: {
      openChat: 'button:has-text("Chat"), [aria-label*="chat" i]',
      input: 'textarea, input[type="text"][placeholder*="ask" i], input[placeholder*="message" i]',
      send: 'button[type="submit"], button[aria-label*="send" i]',
      messages: '[class*="message"], [role="log"] div'
    }
  },
  videotron: {
    id: 'videotron',
    name: 'Videotron',
    color: '#FFD200',
    urls: {
      EN: 'https://www.videotron.com/en/contact-us',
      FR: 'https://www.videotron.com/nous-joindre'
    },
    selectors: {
      openChat: 'button:has-text("Chat"), button:has-text("Clavard"), [aria-label*="chat" i]',
      input: 'textarea, input[type="text"]',
      send: 'button[type="submit"], button[aria-label*="send" i]',
      messages: '[class*="message"], [role="log"] p'
    }
  },
  fido: {
    id: 'fido',
    name: 'Fido',
    color: '#FFE600',
    urls: {
      EN: 'https://www.fido.ca/contact',
      FR: 'https://www.fido.ca/contact?setLanguage=fr'
    },
    selectors: {
      openChat: 'button:has-text("Ask Jack"), button:has-text("Chat"), [aria-label*="chat" i]',
      input: 'textarea, input[type="text"]',
      send: 'button[type="submit"], button[aria-label*="send" i]',
      messages: '[class*="message"], [class*="bubble"]'
    }
  },
  virgin: {
    id: 'virgin',
    name: 'Virgin Plus',
    color: '#E10A0A',
    urls: {
      EN: 'https://www.virginplus.ca/en/support/contact-us.html',
      FR: 'https://www.virginplus.ca/fr/support/contact-us.html'
    },
    selectors: {
      openChat: 'button:has-text("Chat"), [aria-label*="chat" i]',
      input: 'textarea, input[type="text"]',
      send: 'button[type="submit"], button[aria-label*="send" i]',
      messages: '[class*="message"], [role="log"] p'
    }
  },
  koodo: {
    id: 'koodo',
    name: 'Koodo',
    color: '#8C33A4',
    urls: {
      EN: 'https://www.koodomobile.com/en/help',
      FR: 'https://www.koodomobile.com/fr/help'
    },
    selectors: {
      openChat: 'button:has-text("Koodo Assist"), button:has-text("Chat"), [aria-label*="chat" i]',
      input: 'textarea, input[type="text"]',
      send: 'button[type="submit"], button[aria-label*="send" i]',
      messages: '[class*="message"], [role="log"] p'
    }
  },
  freedom: {
    id: 'freedom',
    name: 'Freedom Mobile',
    color: '#F37021',
    urls: {
      EN: 'https://www.freedommobile.ca/en-CA/contact-us',
      FR: 'https://www.freedommobile.ca/fr-CA/contact-us'
    },
    selectors: {
      openChat: 'button:has-text("Chat"), [aria-label*="chat" i]',
      input: 'textarea, input[type="text"]',
      send: 'button[type="submit"], button[aria-label*="send" i]',
      messages: '[class*="message"], [role="log"] p'
    }
  }
};

const PROMPTS = {
  EN: {
    Billing: [
      'Hi, I have a question about a charge on my latest monthly bill.',
      'Can I please speak with a live billing agent?'
    ],
    Sales: [
      'Hi, I am looking to switch my mobile plan and want to check current BYOD offers.',
      'Can you connect me to a live sales representative?'
    ]
  },
  FR: {
    Billing: [
      'Bonjour, j’ai une question concernant des frais sur ma dernière facture.',
      'Puis-je parler à un agent de facturation en direct, s’il vous plaît ?'
    ],
    Sales: [
      'Bonjour, je souhaite changer de forfait mobile et connaître vos offres actuelles.',
      'Pouvez-vous me transférer à un représentant des ventes en direct ?'
    ]
  }
};

module.exports = { BRANDS, PROMPTS };
