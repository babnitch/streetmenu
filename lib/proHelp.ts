// Pro help (ⓘ next to each Pro section title, and /pro/aide): ALL the texts,
// FR + EN, in this one file. Each entry: what the section is for (one
// sentence) and 2–3 tips. Keep them short and true to what the app does.

export interface ProHelp {
  icon: string
  title: { fr: string; en: string }
  what: { fr: string; en: string }
  tips: Array<{ fr: string; en: string }>
}

export const PRO_HELP = {
  overview: {
    icon: '📊', title: { fr: 'Aperçu', en: 'Overview' },
    what: { fr: 'Vos chiffres en un coup d\'œil : commandes, chiffre d\'affaires, plats les plus vendus et visites de votre page.', en: 'Your figures at a glance: orders, revenue, best-selling dishes and visits to your page.' },
    tips: [
      { fr: 'Comparez Aujourd\'hui, 7 jours et 30 jours pour voir la tendance.', en: 'Compare Today, 7 days and 30 days to see the trend.' },
      { fr: 'Les heures les plus chargées vous aident à prévoir le personnel.', en: 'The busiest hours help you plan your staff.' },
      { fr: 'Les commandes annulées et remboursées ne comptent pas dans le chiffre d\'affaires.', en: 'Cancelled and refunded orders are not counted in revenue.' },
    ],
  },
  orders: {
    icon: '📦', title: { fr: 'Commandes', en: 'Orders' },
    what: { fr: 'Toutes les commandes de votre restaurant, de la confirmation à la remise au client.', en: 'All your restaurant\'s orders, from confirmation to handing over.' },
    tips: [
      { fr: 'Confirmez vite : le client reçoit un WhatsApp à chaque étape.', en: 'Confirm quickly: the customer gets a WhatsApp at each step.' },
      { fr: 'Pour une commande payée en ligne, « Remis au client » se valide avec le QR du client.', en: 'For an order paid online, "Handed over" is validated with the customer\'s QR.' },
    ],
  },
  menu: {
    icon: '🍽️', title: { fr: 'Menu', en: 'Menu' },
    what: { fr: 'Vos plats, prix, photos et disponibilités.', en: 'Your dishes, prices, photos and availability.' },
    tips: [
      { fr: 'Marquez un plat « Épuisé » au lieu de le supprimer : il revient en un geste.', en: 'Mark a dish "Sold out" instead of deleting it: it comes back in one tap.' },
      { fr: 'Une bonne photo par plat augmente nettement les commandes.', en: 'One good photo per dish clearly increases orders.' },
      { fr: 'Le menu par jour affiche des plats différents selon le jour de la semaine.', en: 'The daily menu shows different dishes depending on the day of the week.' },
    ],
  },
  vouchers: {
    icon: '🎫', title: { fr: 'Bons', en: 'Vouchers' },
    what: { fr: 'Des codes de réduction pour vos clients.', en: 'Discount codes for your customers.' },
    tips: [
      { fr: 'Fixez une date de fin et un nombre d\'utilisations maximum.', en: 'Set an end date and a maximum number of uses.' },
      { fr: 'Partagez le code sur vos réseaux ou dans un message aux clients.', en: 'Share the code on your social media or in a message to customers.' },
    ],
  },
  validate: {
    icon: '✅', title: { fr: 'Valider', en: 'Validate' },
    what: { fr: 'Scannez le QR d\'un client (ou tapez son code) pour confirmer une remise ou un bon.', en: 'Scan a customer\'s QR (or type their code) to confirm a handover or a voucher.' },
    tips: [
      { fr: 'Si la caméra ne marche pas, saisissez le code à 4 caractères.', en: 'If the camera doesn\'t work, type the 4-character code.' },
      { fr: 'Un QR ne se valide qu\'une fois : un second scan affiche « déjà validé ».', en: 'A QR is validated once: a second scan shows "already validated".' },
    ],
  },
  settings: {
    icon: '⚙️', title: { fr: 'Paramètres', en: 'Settings' },
    what: { fr: 'Horaires, livraison, paiement, temps de préparation et liens de votre restaurant.', en: 'Your restaurant\'s hours, delivery, payment, prep time and links.' },
    tips: [
      { fr: 'Gardez vos horaires à jour : un restaurant fermé ne reçoit pas de commande.', en: 'Keep your hours up to date: a closed restaurant gets no orders.' },
      { fr: 'Un temps de préparation réaliste évite les clients mécontents.', en: 'A realistic prep time avoids unhappy customers.' },
    ],
  },
  hours: {
    icon: '🕐', title: { fr: 'Horaires & disponibilité', en: 'Hours & availability' },
    what: { fr: 'Quand votre restaurant est ouvert aux commandes.', en: 'When your restaurant takes orders.' },
    tips: [
      { fr: 'Utilisez la fermeture temporaire pour une pause sans toucher aux horaires.', en: 'Use the temporary closure for a break without changing your hours.' },
      { fr: 'Les horaires sont à l\'heure du Cameroun.', en: 'Hours are in Cameroon time.' },
    ],
  },
  payment: {
    icon: '💳', title: { fr: 'Mode de paiement', en: 'Payment mode' },
    what: { fr: 'Comment vos clients paient : sur place, en ligne par Mobile Money, ou au choix.', en: 'How your customers pay: on site, online by Mobile Money, or either.' },
    tips: [
      { fr: 'Le paiement en ligne réduit les commandes non récupérées.', en: 'Online payment reduces orders that are never picked up.' },
      { fr: 'Les paiements en ligne apparaissent comme « Payé en ligne » dans l\'Aperçu.', en: 'Online payments show as "Paid online" in the Overview.' },
    ],
  },
  delivery: {
    icon: '🛵', title: { fr: 'Livraison', en: 'Delivery' },
    what: { fr: 'Activez la livraison et fixez ses frais et son délai.', en: 'Turn on delivery and set its fee and time.' },
    tips: [
      { fr: 'Ajoutez le temps de trajet au temps de préparation pour un délai honnête.', en: 'Add the ride time to the prep time for an honest delivery time.' },
      { fr: 'Une offre « Livraison offerte » attire de nouveaux clients.', en: 'A "Free delivery" offer attracts new customers.' },
    ],
  },
  prepTime: {
    icon: '⏱️', title: { fr: 'Temps de préparation', en: 'Prep time' },
    what: { fr: 'Le délai annoncé aux clients avant que la commande soit prête.', en: 'The time announced to customers before the order is ready.' },
    tips: [
      { fr: 'Indiquez une fourchette (ex. 20–35 min) plutôt qu\'un chiffre unique.', en: 'Give a range (e.g. 20–35 min) rather than a single number.' },
      { fr: 'Augmentez-la aux heures de pointe.', en: 'Raise it at peak hours.' },
    ],
  },
  offer: {
    icon: '🏷️', title: { fr: 'Offre du jour', en: 'Today\'s offer' },
    what: { fr: 'Une réduction sur un plat ou la livraison offerte, aujourd\'hui seulement.', en: 'A discount on a dish or free delivery, today only.' },
    tips: [
      { fr: 'Les offres apparaissent sur la page d\'accueil dans « Offres du jour ».', en: 'Offers appear on the home page under "Today\'s offers".' },
      { fr: 'Utilisez-la pour écouler un plat préparé en trop.', en: 'Use it to sell a dish you made too much of.' },
    ],
  },
  links: {
    icon: '🔗', title: { fr: 'Liens', en: 'Links' },
    what: { fr: 'Vos pages Instagram, Facebook, TikTok et votre site, affichés sur votre page.', en: 'Your Instagram, Facebook, TikTok pages and website, shown on your page.' },
    tips: [
      { fr: 'Collez l\'adresse complète, qui commence par https://.', en: 'Paste the full address, starting with https://.' },
    ],
  },
  riders: {
    icon: '🛵', title: { fr: 'Livreurs', en: 'Riders' },
    what: { fr: 'Les personnes qui livrent vos commandes.', en: 'The people who deliver your orders.' },
    tips: [
      { fr: 'Un livreur ajouté voit ses courses dans « Mes livraisons ».', en: 'An added rider sees their runs in "My deliveries".' },
      { fr: 'À la livraison, le client donne un code secret : le livreur le saisit pour terminer.', en: 'On delivery the customer gives a secret code: the rider types it to finish.' },
    ],
  },
  team: {
    icon: '👥', title: { fr: 'Équipe', en: 'Team' },
    what: { fr: 'Invitez un gérant ou du personnel, chacun avec son propre accès.', en: 'Invite a manager or staff, each with their own access.' },
    tips: [
      { fr: 'Le personnel gère les commandes ; le gérant aussi le menu et les paramètres.', en: 'Staff handle orders; a manager also the menu and settings.' },
      { fr: 'Retirez l\'accès d\'une personne qui quitte l\'équipe.', en: 'Remove access for someone who leaves the team.' },
    ],
  },
  myEvents: {
    icon: '🎉', title: { fr: 'Mes événements', en: 'My events' },
    what: { fr: 'Vos événements, leurs réservations et les messages aux participants.', en: 'Your events, their bookings and messages to attendees.' },
    tips: [
      { fr: 'Une affiche verticale (4:5) s\'affiche en entier sur les téléphones.', en: 'A portrait poster (4:5) shows in full on phones.' },
      { fr: 'Fermez les réservations quand la salle est pleine.', en: 'Close bookings when the venue is full.' },
    ],
  },
  eventsOverview: {
    icon: '📊', title: { fr: 'Aperçu des événements', en: 'Events overview' },
    what: { fr: 'Réservations, billets, entrées validées et recettes de vos événements à venir.', en: 'Bookings, tickets, check-ins and revenue of your upcoming events.' },
    tips: [
      { fr: 'Touchez un événement pour voir le remplissage jour par jour.', en: 'Tap an event to see how full each day is.' },
      { fr: 'Le net = recettes en ligne moins la commission.', en: 'Net = online revenue minus the commission.' },
    ],
  },
  doorStaff: {
    icon: '🚪', title: { fr: 'Contrôle à l\'entrée', en: 'Door staff' },
    what: { fr: 'Donnez à des personnes le droit de scanner les billets de cet événement.', en: 'Give people the right to scan this event\'s tickets.' },
    tips: [
      { fr: 'Ajoutez leur numéro WhatsApp : ils scannent depuis « Contrôle à l\'entrée ».', en: 'Add their WhatsApp number: they scan from "Door check".' },
      { fr: 'Un billet ne passe qu\'une fois par jour.', en: 'A ticket gets in once per day.' },
    ],
  },
  scanner: {
    icon: '🎟', title: { fr: 'Contrôler des billets', en: 'Check tickets' },
    what: { fr: 'Scannez les billets à l\'entrée de l\'événement.', en: 'Scan tickets at the event entrance.' },
    tips: [
      { fr: 'Vert = entrée validée ; rouge = refusé, avec la raison.', en: 'Green = check-in validated; red = refused, with the reason.' },
      { fr: 'Sans caméra, tapez le code du billet.', en: 'Without a camera, type the ticket code.' },
    ],
  },
  deliveries: {
    icon: '🛵', title: { fr: 'Mes livraisons', en: 'My deliveries' },
    what: { fr: 'Les commandes que vous devez livrer.', en: 'The orders you have to deliver.' },
    tips: [
      { fr: 'Demandez le code secret au client avant de terminer la livraison.', en: 'Ask the customer for the secret code before finishing the delivery.' },
      { fr: 'Appelez le client depuis la fiche si vous ne trouvez pas l\'adresse.', en: 'Call the customer from the card if you can\'t find the address.' },
    ],
  },
  modules: {
    icon: '🧩', title: { fr: 'Mes modules', en: 'My modules' },
    what: { fr: 'Les fonctions activées pour vous : commandes, livraison, réservations, billets payants…', en: 'The features switched on for you: orders, delivery, bookings, paid tickets…' },
    tips: [
      { fr: 'Demandez un module en un geste ; notre équipe l\'active après vérification.', en: 'Request a module in one tap; our team switches it on after checking.' },
    ],
  },
  proProfile: {
    icon: '🪪', title: { fr: 'Profil Pro', en: 'Pro profile' },
    what: { fr: 'Le nom d\'organisateur affiché sur vos événements et vos coordonnées Pro.', en: 'The organiser name shown on your events and your Pro details.' },
    tips: [
      { fr: 'Ce nom est pré-rempli à chaque nouvel événement.', en: 'This name is pre-filled for each new event.' },
    ],
  },
} satisfies Record<string, ProHelp>

export type ProHelpId = keyof typeof PRO_HELP
export const PRO_HELP_IDS = Object.keys(PRO_HELP) as ProHelpId[]
