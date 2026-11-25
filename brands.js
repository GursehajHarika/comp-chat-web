const BRANDS = {
  Rogers: {
    name: 'Rogers',
    color: '#DA291C',
    urls: {
      Consumer: {
        EN: {
          Sales: 'https://www.rogers.com/phones',
          Billing: 'https://www.rogers.com/support'
        },
        FR: {
          Sales: 'https://www.rogers.com/phones?setLanguage=fr',
          Billing: 'https://www.rogers.com/support?setLanguage=fr'
        }
      },
      SMB: {
        EN: {
          Sales: 'https://www.rogers.com/business/wireless/devices',
          Billing: 'https://www.rogers.com/business/support'
        },
        FR: {
          Sales: 'https://www.rogers.com/business/wireless/devices?setLanguage=fr',
          Billing: 'https://www.rogers.com/business/support?setLanguage=fr'
        }
      }
    },
    selectors: {
      openChat:
        'button:has-text("Need Help"), [role="button"]:has-text("Need Help"), a:has-text("Need Help"), text=/^\\s*Need Help\\??\\s*$/i, text=/Besoin d[\'’]aide/i, [aria-label*="Need Help" i], [aria-label*="chat" i]',
      input:
        'textarea, input[type="text"][placeholder*="message" i], input[placeholder*="question" i], [contenteditable="true"]',
      send: 'button[type="submit"], button[aria-label*="send" i], button[aria-label*="envoyer" i]',
      messages: '[class*="message"], [class*="bubble"], [role="log"] p, [role="log"] span'
    }
  },
  Videotron: {
    name: 'Videotron',
    color: '#FACC15',
    urls: {
      Consumer: {
        EN: {
          Sales: 'https://www.videotron.com/en/mobile/cell-phones',
          Billing: 'https://www.videotron.com/en/support/mobile'
        },
        FR: {
          Sales: 'https://www.videotron.com/mobilite/telephones-mobiles',
          Billing: 'https://www.videotron.com/soutien/mobilite'
        }
      },
      SMB: {
        EN: {
          Sales: 'https://www.videotron.com/business/mobile/cell-phones',
          Billing: 'https://www.videotron.com/business/support'
        },
        FR: {
          Sales: 'https://www.videotron.com/affaires/mobilite/telephones-mobiles',
          Billing: 'https://www.videotron.com/affaires/soutien'
        }
      }
    },
    selectors: {
      openChat:
        'button[aria-label*="chat" i], button[aria-label*="clavard" i], button[aria-label*="messenger" i], [id*="genesys" i] button, iframe[title*="chat" i], iframe[title*="messenger" i], iframe[title*="clavard" i], button:has-text("Chat"), button:has-text("Clavard")',
      input:
        'textarea, input[type="text"][placeholder*="message" i], input[placeholder*="question" i], [contenteditable="true"]',
      send: 'button[type="submit"], button[aria-label*="send" i], button[aria-label*="envoyer" i]',
      messages: '[class*="message"], [class*="bubble"], [role="log"] p, [role="log"] span'
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
      'Hi, I am looking to switch my mobile plan and want to check current offers.',
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

function resolveBrandUrl(brand, segment, useCase, language) {
  const seg = /business|smb/i.test(segment || '') ? 'SMB' : 'Consumer';
  const lang = /^fr/i.test(language || '') ? 'FR' : 'EN';
  const uc = /sale/i.test(useCase || '') ? 'Sales' : 'Billing';
  return BRANDS[brand]?.urls?.[seg]?.[lang]?.[uc] || '';
}

module.exports = { BRANDS, PROMPTS, resolveBrandUrl };
