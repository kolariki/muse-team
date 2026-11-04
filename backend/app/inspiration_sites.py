"""The sites the inspiration library starts from: public pages with good design, by line of business. Only the addresses live
here; the captures are taken by the server and kept on its disk (see inspiration.py). (name, url, look)"""

SITES: dict[str, dict] = {
    "belleza-barberia": {"label": "barbería, peluquería, estética y cosmética", "keywords": ["barber", "peluquer", "estética", "estetica", "cosmétic", "cosmetic", "belleza", "maquillaje", "spa", "uñas", "skincare"], "sites": [
        ("Glossier", "https://www.glossier.com", "claro"), ("Aesop", "https://www.aesop.com", "editorial"), ("Rhode", "https://www.rhodeskin.com", "minimal"),
        ("The Ordinary", "https://theordinary.com", "minimal"), ("Fenty Beauty", "https://fentybeauty.com", "colorido"), ("Harry's", "https://www.harrys.com", "claro"),
        ("Dollar Shave Club", "https://www.dollarshaveclub.com", "colorido"), ("Schorem", "https://schorembarbier.nl", "oscuro"), ("Baxter of California", "https://baxterofcalifornia.com", "editorial"),
        ("Byredo", "https://www.byredo.com", "minimal"), ("Le Labo", "https://www.lelabofragrances.com", "editorial"), ("Drunk Elephant", "https://www.drunkelephant.com", "colorido"),
    ]},
    "gastronomia": {"label": "restaurante, café, bar y comida", "keywords": ["restaurant", "café", "cafe", "cafetería", "bar ", "cervecer", "pizzer", "panader", "comida", "gastronom", "vino", "bodega", "heladería", "menú", "menu", "delivery"], "sites": [
        ("Blue Bottle", "https://bluebottlecoffee.com", "claro"), ("Noma", "https://noma.dk", "minimal"), ("Sweetgreen", "https://www.sweetgreen.com", "claro"),
        ("Oatly", "https://www.oatly.com", "tipografico"), ("Graza", "https://www.graza.co", "colorido"), ("Fishwife", "https://eatfishwife.com", "colorido"),
        ("Olipop", "https://drinkolipop.com", "colorido"), ("Stumptown", "https://www.stumptowncoffee.com", "editorial"), ("Eleven Madison Park", "https://www.elevenmadisonpark.com", "minimal"),
        ("Shake Shack", "https://shakeshack.com", "claro"), ("Chipotle", "https://www.chipotle.com", "colorido"), ("Catena Zapata", "https://www.catenazapata.com", "editorial"),
        ("Tatte", "https://tattebakery.com", "claro"), ("Omnom", "https://www.omnomchocolate.com", "colorido"),
    ]},
    "tienda": {"label": "tienda online, moda y productos", "keywords": ["tienda", "ecommerce", "e-commerce", "moda", "ropa", "zapat", "producto", "vender", "catálogo", "catalogo", "carrito", "joyer", "accesorios"], "sites": [
        ("Allbirds", "https://www.allbirds.com", "claro"), ("Everlane", "https://www.everlane.com", "minimal"), ("Nike", "https://www.nike.com", "tipografico"),
        ("Apple", "https://www.apple.com", "minimal"), ("Bellroy", "https://bellroy.com", "claro"), ("Away", "https://www.awaytravel.com", "claro"),
        ("Ridge", "https://ridge.com", "oscuro"), ("Gymshark", "https://www.gymshark.com", "oscuro"), ("Patagonia", "https://www.patagonia.com", "editorial"),
        ("Mejuri", "https://mejuri.com", "minimal"), ("Teenage Engineering", "https://teenage.engineering", "minimal"), ("Nothing", "https://nothing.tech", "oscuro"),
        ("Rains", "https://www.rains.com", "minimal"), ("Our Place", "https://fromourplace.com", "colorido"), ("Quince", "https://www.quince.com", "claro"),
    ]},
    "deporte-fitness": {"label": "gimnasio, deporte y bienestar", "keywords": ["gimnasio", "gym", "fitness", "entrenamiento", "crossfit", "yoga", "pilates", "deporte", "club", "running", "nutrici"], "sites": [
        ("Peloton", "https://www.onepeloton.com", "oscuro"), ("Equinox", "https://www.equinox.com", "oscuro"), ("Strava", "https://www.strava.com", "colorido"),
        ("Whoop", "https://www.whoop.com", "oscuro"), ("Barry's", "https://www.barrys.com", "oscuro"), ("Alo Moves", "https://www.alomoves.com", "claro"),
        ("Tonal", "https://www.tonal.com", "oscuro"), ("Headspace", "https://www.headspace.com", "colorido"), ("Calm", "https://www.calm.com", "colorido"),
        ("On Running", "https://www.on.com", "minimal"), ("Hoka", "https://www.hoka.com", "colorido"), ("Oura", "https://ouraring.com", "oscuro"),
    ]},
    "salud": {"label": "salud, clínica y consultorio", "keywords": ["clínica", "clinica", "médic", "medic", "salud", "consultorio", "dentista", "odonto", "psicolog", "terapia", "veterinari", "hospital", "turnos médicos"], "sites": [
        ("One Medical", "https://www.onemedical.com", "claro"), ("Forward", "https://goforward.com", "minimal"), ("Hims", "https://www.hims.com", "editorial"),
        ("Ro", "https://ro.co", "claro"), ("Oscar", "https://www.hioscar.com", "colorido"), ("Tend", "https://www.hellotend.com", "colorido"),
        ("Zocdoc", "https://www.zocdoc.com", "colorido"), ("Maven Clinic", "https://www.mavenclinic.com", "claro"), ("Talkspace", "https://www.talkspace.com", "claro"),
        ("Function Health", "https://www.functionhealth.com", "minimal"), ("Parsley Health", "https://www.parsleyhealth.com", "claro"),
    ]},
    "inmobiliaria-arquitectura": {"label": "inmobiliaria, arquitectura y construcción", "keywords": ["inmobiliar", "propiedad", "alquiler", "arquitect", "construc", "reforma", "desarrolladora", "decoraci", "interiorismo", "muebles"], "sites": [
        ("Compass", "https://www.compass.com", "minimal"), ("Airbnb", "https://www.airbnb.com", "claro"), ("Zillow", "https://www.zillow.com", "claro"),
        ("Sotheby's Realty", "https://www.sothebysrealty.com", "editorial"), ("BIG", "https://big.dk", "minimal"), ("Herzog & de Meuron", "https://www.herzogdemeuron.com", "minimal"),
        ("Zaha Hadid Architects", "https://www.zaha-hadid.com", "oscuro"), ("Foster + Partners", "https://www.fosterandpartners.com", "minimal"), ("Article", "https://www.article.com", "claro"),
        ("Hem", "https://www.hem.com", "editorial"), ("Muuto", "https://www.muuto.com", "minimal"), ("Ikea", "https://www.ikea.com", "colorido"),
    ]},
    "educacion": {"label": "educación, cursos y academias", "keywords": ["curso", "educaci", "escuela", "academia", "colegio", "universidad", "capacitaci", "aprender", "clases", "tutor"], "sites": [
        ("Duolingo", "https://www.duolingo.com", "colorido"), ("Masterclass", "https://www.masterclass.com", "oscuro"), ("Brilliant", "https://brilliant.org", "claro"),
        ("Khan Academy", "https://www.khanacademy.org", "claro"), ("Coursera", "https://www.coursera.org", "claro"), ("Domestika", "https://www.domestika.org", "colorido"),
        ("Skillshare", "https://www.skillshare.com", "claro"), ("Platzi", "https://platzi.com", "oscuro"), ("Codecademy", "https://www.codecademy.com", "colorido"),
        ("Maven", "https://maven.com", "claro"), ("Minerva University", "https://www.minerva.edu", "editorial"),
    ]},
    "software": {"label": "software, SaaS y herramientas", "keywords": ["saas", "software", "plataforma", "dashboard", "panel", "productividad", "crm", "herramienta", "startup", "gestión", "gestion"], "sites": [
        ("Linear", "https://linear.app", "oscuro"), ("Notion", "https://www.notion.com", "claro"), ("Stripe", "https://stripe.com", "colorido"),
        ("Vercel", "https://vercel.com", "oscuro"), ("Figma", "https://www.figma.com", "colorido"), ("Framer", "https://www.framer.com", "oscuro"),
        ("Raycast", "https://www.raycast.com", "oscuro"), ("Superlist", "https://www.superlist.com", "colorido"), ("Attio", "https://attio.com", "claro"),
        ("Loom", "https://www.loom.com", "claro"), ("Miro", "https://miro.com", "colorido"), ("Webflow", "https://webflow.com", "oscuro"),
        ("Resend", "https://resend.com", "oscuro"), ("Supabase", "https://supabase.com", "oscuro"), ("Slack", "https://slack.com", "colorido"),
        ("Pitch", "https://pitch.com", "colorido"), ("Cal.com", "https://cal.com", "minimal"), ("Clerk", "https://clerk.com", "claro"),
    ]},
    "finanzas": {"label": "finanzas, banca, seguros y contabilidad", "keywords": ["banco", "finanz", "fintech", "pagos", "seguro", "contab", "inversi", "préstamo", "prestamo", "billetera", "factura", "impuesto", "abogad", "estudio jurídico", "legal"], "sites": [
        ("Mercury", "https://mercury.com", "oscuro"), ("Monzo", "https://monzo.com", "colorido"), ("Wise", "https://wise.com", "colorido"),
        ("Revolut", "https://www.revolut.com", "oscuro"), ("Ramp", "https://ramp.com", "claro"), ("Brex", "https://www.brex.com", "oscuro"),
        ("Lemonade", "https://www.lemonade.com", "colorido"), ("Nubank", "https://nubank.com.br", "colorido"), ("Ualá", "https://www.uala.com.ar", "colorido"),
        ("Wealthfront", "https://www.wealthfront.com", "claro"), ("Clio", "https://www.clio.com", "claro"), ("Ironclad", "https://ironcladapp.com", "claro"),
    ]},
    "agencia-portfolio": {"label": "agencia, estudio, portfolio y fotografía", "keywords": ["agencia", "estudio de diseño", "portfolio", "portafolio", "fotógraf", "fotograf", "freelance", "consultor", "marca personal", "cv"], "sites": [
        ("Huge", "https://www.hugeinc.com", "oscuro"), ("Pentagram", "https://www.pentagram.com", "minimal"), ("Instrument", "https://www.instrument.com", "oscuro"),
        ("Basic/Dept", "https://www.basicagency.com", "oscuro"), ("Locomotive", "https://locomotive.ca", "tipografico"), ("Active Theory", "https://activetheory.net", "oscuro"),
        ("Resn", "https://resn.co.nz", "oscuro"), ("Unseen Studio", "https://unseen.co", "oscuro"), ("Metalab", "https://www.metalab.com", "oscuro"),
        ("Ueno", "https://www.ueno.co", "tipografico"), ("Brikken", "https://brikken.co", "tipografico"), ("Lusion", "https://lusion.co", "oscuro"),
        ("Bruno Simon", "https://bruno-simon.com", "colorido"), ("Fantasy", "https://fantasy.co", "oscuro"),
    ]},
    "turismo": {"label": "turismo, hoteles y viajes", "keywords": ["hotel", "turismo", "viaje", "hostel", "alojamiento", "cabaña", "excursion", "excursión", "aerol", "tour", "camping"], "sites": [
        ("Aman", "https://www.aman.com", "editorial"), ("Ace Hotel", "https://acehotel.com", "editorial"), ("Hoxton", "https://thehoxton.com", "colorido"),
        ("Booking", "https://www.booking.com", "claro"), ("Hipcamp", "https://www.hipcamp.com", "claro"), ("Getaway", "https://getaway.house", "claro"),
        ("Tablet Hotels", "https://www.tablethotels.com", "editorial"), ("Icelandair", "https://www.icelandair.com", "colorido"), ("Lonely Planet", "https://www.lonelyplanet.com", "colorido"),
        ("Black Tomato", "https://www.blacktomato.com", "editorial"), ("Soho House", "https://www.sohohouse.com", "minimal"),
    ]},
    "eventos-cultura": {"label": "eventos, música, arte y cultura", "keywords": ["evento", "boda", "casamiento", "fiesta", "música", "musica", "banda", "teatro", "museo", "arte", "festival", "galería", "galeria", "entradas", "cine"], "sites": [
        ("MoMA", "https://www.moma.org", "tipografico"), ("Tate", "https://www.tate.org.uk", "tipografico"), ("Spotify", "https://www.spotify.com", "oscuro"),
        ("Sónar", "https://sonar.es", "colorido"), ("Coachella", "https://www.coachella.com", "colorido"), ("A24", "https://a24films.com", "minimal"),
        ("Mubi", "https://mubi.com", "oscuro"), ("Bandcamp", "https://bandcamp.com", "claro"), ("Dice", "https://dice.fm", "oscuro"),
        ("Zola", "https://www.zola.com", "claro"), ("Met Museum", "https://www.metmuseum.org", "editorial"), ("Pitchfork", "https://pitchfork.com", "editorial"),
    ]},
    "medios-comunidad": {"label": "blog, medios, comunidad y ONG", "keywords": ["blog", "revista", "noticias", "newsletter", "comunidad", "ong", "fundación", "fundacion", "donar", "iglesia", "podcast"], "sites": [
        ("The Verge", "https://www.theverge.com", "colorido"), ("Bloomberg", "https://www.bloomberg.com", "tipografico"), ("It's Nice That", "https://www.itsnicethat.com", "tipografico"),
        ("Substack", "https://substack.com", "claro"), ("Ghost", "https://ghost.org", "oscuro"), ("charity: water", "https://www.charitywater.org", "editorial"),
        ("WWF", "https://www.worldwildlife.org", "editorial"), ("The Pudding", "https://pudding.cool", "colorido"), ("Stripe Press", "https://press.stripe.com", "editorial"),
        ("Are.na", "https://www.are.na", "minimal"), ("Rest of World", "https://restofworld.org", "colorido"),
    ]},
    "autos-transporte": {"label": "autos, talleres, transporte y logística", "keywords": ["auto", "taller", "mecánic", "mecanic", "concesionar", "logística", "logistica", "envíos", "envios", "transporte", "flete", "moto", "bicicleta"], "sites": [
        ("Tesla", "https://www.tesla.com", "minimal"), ("Rivian", "https://rivian.com", "editorial"), ("Polestar", "https://www.polestar.com", "minimal"),
        ("Porsche", "https://www.porsche.com", "oscuro"), ("VanMoof", "https://www.vanmoof.com", "oscuro"), ("Flexport", "https://www.flexport.com", "oscuro"),
        ("Uber", "https://www.uber.com", "oscuro"), ("Cowboy", "https://cowboy.com", "colorido"), ("Lucid", "https://lucidmotors.com", "oscuro"),
    ]},
    "mascotas-hogar": {"label": "mascotas, hogar y servicios del barrio", "keywords": ["mascota", "perro", "gato", "pet ", "jardin", "jardín", "plomer", "electricista", "limpieza", "mudanza", "vivero", "plantas", "lavander"], "sites": [
        ("The Farmer's Dog", "https://www.thefarmersdog.com", "claro"), ("Wild One", "https://wildone.com", "colorido"), ("Fable Pets", "https://fablepets.com", "minimal"),
        ("The Sill", "https://www.thesill.com", "claro"), ("Bloomscape", "https://bloomscape.com", "claro"), ("Thumbtack", "https://www.thumbtack.com", "claro"),
        ("Rover", "https://www.rover.com", "claro"), ("Grove", "https://www.grove.co", "claro"), ("Branch Basics", "https://branchbasics.com", "minimal"),
    ]},
}
