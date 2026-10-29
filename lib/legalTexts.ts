// Texts of the public pages (U2): À propos, Conditions d'utilisation,
// Confidentialité, Remboursements. DRAFTS written from what the app really
// does and stores today — to be reviewed by someone qualified before they
// are relied on (an admin-only banner says so on each page).
// {company} is replaced with the company name from Admin → Plateforme (or
// "l'éditeur de Tchop & Ndjoka" / "the publisher of Tchop & Ndjoka").

export interface LegalSection { h: string; p: string[] }
export interface LegalText { title: string; intro?: string; sections: LegalSection[] }
export type LegalPageKey = 'about' | 'terms' | 'privacy' | 'refunds'

export const LEGAL_UPDATED = '2026-10-29'

export const LEGAL_TEXTS: Record<LegalPageKey, { fr: LegalText; en: LegalText }> = {
  about: {
    fr: {
      title: 'À propos de Tchop & Ndjoka',
      intro: 'Tchop & Ndjoka aide à trouver où manger et quoi faire en ville, à commander auprès des restaurants et à réserver des sorties — sur le site et sur WhatsApp.',
      sections: [
        { h: 'Ce que nous faisons', p: [
          'Les restaurants et bars présentent leur carte, leurs horaires, leurs offres et, s\'ils le souhaitent, prennent des commandes (à emporter ou en livraison par leurs propres livreurs).',
          'Les organisateurs publient leurs événements ; vous pouvez réserver gratuitement, payer sur place ou acheter un billet par Mobile Money selon l\'événement.',
          'Les confirmations, rappels et suivis passent par WhatsApp (ou SMS si WhatsApp ne passe pas).',
        ] },
        { h: 'Ce que nous ne faisons pas', p: [
          'Tchop & Ndjoka ne cuisine pas, ne livre pas et n\'organise pas les événements : chaque restaurant et chaque organisateur reste responsable de ce qu\'il propose.',
          'Tout ce qui est publié (restaurants, événements, lieux) est vérifié par notre équipe avant d\'être visible.',
        ] },
        { h: 'Qui nous sommes', p: ['Tchop & Ndjoka est édité par {company}. Nos coordonnées sont sur la page Contact.'] },
      ],
    },
    en: {
      title: 'About Tchop & Ndjoka',
      intro: 'Tchop & Ndjoka helps you find where to eat and what to do in town, order from restaurants and book outings — on the website and on WhatsApp.',
      sections: [
        { h: 'What we do', p: [
          'Restaurants and bars show their menu, opening hours and offers and, if they wish, take orders (take-away, or delivery by their own riders).',
          'Organisers publish their events; you can book for free, pay at the door or buy a ticket with Mobile Money, depending on the event.',
          'Confirmations, reminders and updates are sent on WhatsApp (or SMS when WhatsApp doesn\'t get through).',
        ] },
        { h: 'What we don\'t do', p: [
          'Tchop & Ndjoka doesn\'t cook, deliver or run events: each restaurant and organiser is responsible for what they offer.',
          'Everything published (restaurants, events, places) is checked by our team before it goes live.',
        ] },
        { h: 'Who we are', p: ['Tchop & Ndjoka is published by {company}. Our contact details are on the Contact page.'] },
      ],
    },
  },

  terms: {
    fr: {
      title: 'Conditions d\'utilisation',
      sections: [
        { h: '1. Le service', p: [
          'Tchop & Ndjoka ({company}) met en relation des clients avec des restaurants, des bars et des organisateurs d\'événements, sur le site et sur WhatsApp. L\'utilisation du service vaut acceptation de ces conditions.',
        ] },
        { h: '2. Votre compte', p: [
          'Vous vous connectez avec votre numéro de téléphone et un code reçu par WhatsApp ou SMS. Vous êtes responsable de l\'usage de votre numéro et des commandes et réservations passées avec.',
          'Donnez un nom et des informations exactes. Nous pouvons suspendre un compte en cas d\'abus (fausses commandes, harcèlement, fraude au paiement).',
        ] },
        { h: '3. Commandes et réservations', p: [
          'Le contrat de vente ou de prestation est conclu entre vous et le restaurant ou l\'organisateur. Prix, disponibilité, préparation, livraison et déroulement de l\'événement relèvent de leur responsabilité.',
          'Une commande peut être refusée ou annulée par le restaurant ; une réservation peut nécessiter la confirmation de l\'organisateur. Vous êtes prévenu sur WhatsApp.',
          'Les codes et QR de vos billets, commandes et bons sont personnels : ne les partagez qu\'au moment de les utiliser.',
        ] },
        { h: '4. Paiements', p: [
          'Selon le restaurant ou l\'événement : paiement sur place, ou paiement à l\'avance par Mobile Money via notre prestataire de paiement (PawaPay). Les remboursements sont décrits sur la page Remboursements.',
        ] },
        { h: '5. Professionnels', p: [
          'Les restaurants, bars et organisateurs s\'engagent à publier des informations exactes (photos, prix, horaires, dates) dont ils détiennent les droits, et à honorer les commandes et réservations acceptées. Notre équipe vérifie les publications et peut les refuser ou les retirer.',
        ] },
        { h: '6. Contenus et signalements', p: [
          'Avis, commentaires et photos doivent rester respectueux et légaux. Vous pouvez signaler un contenu ; nous pouvons le retirer.',
        ] },
        { h: '7. Responsabilité', p: [
          'Nous faisons de notre mieux pour que le service fonctionne, sans pouvoir garantir l\'absence d\'interruption. Nous ne sommes pas responsables de l\'exécution des commandes et événements par les professionnels.',
        ] },
        { h: '8. Modifications et contact', p: [
          'Ces conditions peuvent évoluer ; la date de mise à jour figure en bas de page. Pour toute question : voir la page Contact.',
        ] },
      ],
    },
    en: {
      title: 'Terms of use',
      sections: [
        { h: '1. The service', p: [
          'Tchop & Ndjoka ({company}) connects customers with restaurants, bars and event organisers, on the website and on WhatsApp. Using the service means accepting these terms.',
        ] },
        { h: '2. Your account', p: [
          'You log in with your phone number and a code received by WhatsApp or SMS. You are responsible for the use of your number and the orders and bookings made with it.',
          'Give a real name and accurate details. We may suspend an account in case of abuse (fake orders, harassment, payment fraud).',
        ] },
        { h: '3. Orders and bookings', p: [
          'The sale or service is between you and the restaurant or organiser. Prices, availability, preparation, delivery and how the event runs are their responsibility.',
          'An order may be refused or cancelled by the restaurant; a booking may need the organiser\'s confirmation. You are told on WhatsApp.',
          'The codes and QRs of your tickets, orders and vouchers are personal: only share them when you use them.',
        ] },
        { h: '4. Payments', p: [
          'Depending on the restaurant or event: pay on site, or pay upfront with Mobile Money through our payment provider (PawaPay). Refunds are described on the Refunds page.',
        ] },
        { h: '5. Professionals', p: [
          'Restaurants, bars and organisers agree to publish accurate information (photos, prices, opening hours, dates) they hold the rights to, and to honour the orders and bookings they accept. Our team checks publications and may refuse or remove them.',
        ] },
        { h: '6. Content and reports', p: [
          'Reviews, comments and photos must stay respectful and lawful. You can report content; we may remove it.',
        ] },
        { h: '7. Liability', p: [
          'We do our best to keep the service running but can\'t guarantee it will never be interrupted. We are not responsible for how professionals carry out orders and events.',
        ] },
        { h: '8. Changes and contact', p: [
          'These terms may change; the date of the last update is at the bottom. Questions: see the Contact page.',
        ] },
      ],
    },
  },

  privacy: {
    fr: {
      title: 'Politique de confidentialité',
      intro: 'Responsable du traitement : {company}. Cette page décrit les données que Tchop & Ndjoka traite réellement aujourd\'hui.',
      sections: [
        { h: 'Les données que nous traitons', p: [
          'Compte : numéro de téléphone, nom, ville, langue préférée ; pour les professionnels, nom affiché et numéro de notification.',
          'Commandes : articles, montants, statut, et pour une livraison l\'adresse, le point de repère et le téléphone de livraison.',
          'Réservations : événement, nombre de places, codes de réservation, entrées validées.',
          'Paiements Mobile Money : numéro utilisé, montant, statut et références de la transaction.',
          'Messages : les messages WhatsApp et SMS que nous vous envoyons (contenu et statut de remise) et ceux que vous envoyez à notre numéro.',
          'Contenus des professionnels : photos, cartes et menus, informations du restaurant ou de l\'événement.',
          'Avis, commentaires, signalements, bons de réduction utilisés, favoris ; les clics « Commander sur WhatsApp / Appeler » sur une page restaurant (pour indiquer au restaurant combien de clients nous lui envoyons).',
          'Sur votre appareil : un cookie de session (connexion) et des préférences locales (ville, langue, panier, mode économique). Votre position n\'est utilisée que si vous triez par distance, sur votre appareil, et n\'est pas enregistrée.',
        ] },
        { h: 'Pourquoi', p: [
          'Vous connecter, faire fonctionner commandes, réservations et paiements, vous envoyer confirmations et suivis, permettre aux restaurants et organisateurs de vous servir, lutter contre la fraude et les abus, et tenir une comptabilité.',
          'Nous ne vendons pas vos données. Les messages d\'information sur les nouveaux événements ne sont envoyés que si vous vous y êtes abonné.',
        ] },
        { h: 'Avec qui', p: [
          'Le restaurant ou l\'organisateur concerné reçoit ce qu\'il faut pour votre commande ou réservation (nom, téléphone, articles, adresse de livraison) ; un livreur du restaurant reçoit l\'adresse et le téléphone de livraison.',
          'Nos prestataires : Twilio et Meta (WhatsApp) pour les messages et SMS, PawaPay et votre opérateur Mobile Money pour les paiements, Supabase (base de données et fichiers) et Vercel (hébergement du site), Mapbox (cartes).',
        ] },
        { h: 'Combien de temps', p: [
          'Tant que votre compte est actif. Après suppression, les montants des commandes et des paiements sont conservés sans votre nom ni votre numéro, pour les obligations comptables.',
        ] },
        { h: 'Vos droits', p: [
          'Vous pouvez demander l\'accès, la correction ou la suppression de vos données : page Suppression des données, ou via la page Contact.',
        ] },
      ],
    },
    en: {
      title: 'Privacy policy',
      intro: 'Data controller: {company}. This page describes the data Tchop & Ndjoka really processes today.',
      sections: [
        { h: 'The data we process', p: [
          'Account: phone number, name, city, preferred language; for professionals, the displayed name and a notification number.',
          'Orders: items, amounts, status, and for a delivery the address, landmark and delivery phone.',
          'Bookings: event, number of places, booking codes, check-ins.',
          'Mobile Money payments: the number used, amount, status and transaction references.',
          'Messages: the WhatsApp and SMS messages we send you (content and delivery status) and those you send to our number.',
          'Professionals\' content: photos, menus, restaurant or event information.',
          'Reviews, comments, reports, vouchers used, favourites; "Order on WhatsApp / Call" taps on a restaurant page (to tell the restaurant how many customers we send).',
          'On your device: a session cookie (login) and local preferences (city, language, cart, low-data mode). Your location is only used if you sort by distance, on your device, and is not stored.',
        ] },
        { h: 'Why', p: [
          'To log you in, run orders, bookings and payments, send confirmations and updates, let restaurants and organisers serve you, fight fraud and abuse, and keep accounts.',
          'We don\'t sell your data. News about new events is only sent if you subscribed to it.',
        ] },
        { h: 'Who we share with', p: [
          'The restaurant or organiser concerned gets what it needs for your order or booking (name, phone, items, delivery address); a restaurant\'s rider gets the delivery address and phone.',
          'Our providers: Twilio and Meta (WhatsApp) for messages and SMS, PawaPay and your Mobile Money operator for payments, Supabase (database and files) and Vercel (website hosting), Mapbox (maps).',
        ] },
        { h: 'How long', p: [
          'As long as your account is active. After deletion, order and payment amounts are kept without your name or number, for accounting obligations.',
        ] },
        { h: 'Your rights', p: [
          'You can ask to access, correct or delete your data: Data deletion page, or through the Contact page.',
        ] },
      ],
    },
  },

  refunds: {
    fr: {
      title: 'Remboursements',
      intro: 'Les règles d\'aujourd\'hui, telles que le service fonctionne réellement.',
      sections: [
        { h: 'Paiement sur place', p: [
          'Si vous payez au restaurant, à la livraison ou à l\'entrée, rien n\'est prélevé par Tchop & Ndjoka : un éventuel remboursement se règle directement avec le restaurant ou l\'organisateur.',
        ] },
        { h: 'Paiement à l\'avance par Mobile Money', p: [
          'Certaines commandes et certains billets se paient à l\'avance par Mobile Money (via PawaPay). Le paiement est confirmé par WhatsApp.',
          'Si le restaurant refuse ou annule une commande payée, ou si un événement est annulé, notre équipe rembourse manuellement sur le numéro Mobile Money utilisé pour payer. Contactez-nous si vous n\'avez pas été remboursé.',
          'Pour annuler vous-même un billet payé, contactez l\'organisateur ; un billet payé ne s\'annule pas depuis l\'application.',
        ] },
        { h: 'Problème avec une commande ou un événement', p: [
          'Écrivez-nous (page Contact) avec le code de la commande ou du billet (#AB12). Nous voyons avec le restaurant ou l\'organisateur.',
        ] },
      ],
    },
    en: {
      title: 'Refunds',
      intro: 'Today\'s rules, as the service really works.',
      sections: [
        { h: 'Paying on site', p: [
          'If you pay at the restaurant, on delivery or at the door, Tchop & Ndjoka takes nothing: any refund is settled directly with the restaurant or organiser.',
        ] },
        { h: 'Paying upfront with Mobile Money', p: [
          'Some orders and tickets are paid upfront with Mobile Money (through PawaPay). The payment is confirmed on WhatsApp.',
          'If the restaurant refuses or cancels a paid order, or an event is cancelled, our team refunds manually to the Mobile Money number used to pay. Contact us if you haven\'t been refunded.',
          'To cancel a paid ticket yourself, contact the organiser; a paid ticket can\'t be cancelled in the app.',
        ] },
        { h: 'A problem with an order or event', p: [
          'Write to us (Contact page) with the order or ticket code (#AB12). We\'ll sort it out with the restaurant or organiser.',
        ] },
      ],
    },
  },
}
