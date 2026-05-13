/**
 * Seed UK National Trails into the trails table.
 *
 * Waypoints are ordered [longitude, latitude] to match PostGIS / WKT convention
 * (x = lng, y = lat).  Each trail uses the real start/end points and enough
 * intermediate waypoints to give a faithful shape of the route.  These simplified
 * geometries can be swapped for full GPX data later without changing any other code.
 *
 * Run with:  npm run db:seed-trails
 */

import pg from "pg";
import { fileURLToPath } from "url";
import { dirname } from "path";

const { Pool } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));
void __dirname; // referenced for context only

// ── Trail definitions ─────────────────────────────────────────────────────────
// Each waypoint is [longitude, latitude].
// total_distance is in metres (same unit Strava uses for activities).

const trails = [
  // ── 1. South Downs Way ────────────────────────────────────────────────────
  {
    name: "South Downs Way",
    slug: "south-downs-way",
    description:
      "A 100-mile chalk ridge walk from Winchester to Eastbourne, traversing the full length of the South Downs National Park.",
    total_distance: 160_934,
    region: "South England",
    waypoints: [
      [-1.3082, 51.0632], // Winchester (start)
      [-1.1827, 51.0274], // Beacon Hill
      [-0.9707, 50.9569], // Buriton
      [-0.8806, 50.9540], // South Harting
      [-0.8177, 50.9455], // Cocking
      [-0.7011, 50.9181], // Graffham Down
      [-0.5762, 50.8876], // Bignor Hill
      [-0.5270, 50.9038], // Amberley
      [-0.3947, 50.8960], // Washington
      [-0.3269, 50.8839], // Steyning
      [-0.2153, 50.8954], // Devil's Dyke
      [-0.1106, 50.9018], // Ditchling Beacon
      [-0.0189, 50.8748], // Housedean Farm
      [0.0694,  50.8399], // Rodmell
      [0.1564,  50.8027], // Alfriston
      [0.2133,  50.7804], // Jevington
      [0.2763,  50.7705], // Eastbourne (end)
    ],
  },

  // ── 2. North Downs Way ────────────────────────────────────────────────────
  {
    name: "North Downs Way",
    slug: "north-downs-way",
    description:
      "A 153-mile National Trail running from Farnham in Surrey to Dover in Kent, following the chalk ridge of the North Downs.",
    total_distance: 246_232,
    region: "South East England",
    waypoints: [
      [-0.7981, 51.2148], // Farnham (start)
      [-0.7183, 51.2307], // Seale
      [-0.6650, 51.2256], // Puttenham
      [-0.5754, 51.2353], // Guildford
      [-0.4511, 51.2356], // Dorking area
      [-0.3043, 51.2487], // Box Hill
      [-0.2016, 51.2449], // Reigate
      [-0.1598, 51.2480], // Merstham
      [-0.0073, 51.2592], // Oxted
      [ 0.1870, 51.3100], // Otford
      [ 0.2992, 51.3021], // Wrotham
      [ 0.4015, 51.3170], // Trottiscliffe
      [ 0.5217, 51.2870], // Detling
      [ 0.6384, 51.2650], // Hollingbourne
      [ 0.7918, 51.2233], // Charing
      [ 0.9400, 51.1838], // Wye
      [ 1.0792, 51.2802], // Canterbury
      [ 1.1736, 51.2204], // Barham
      [ 1.2438, 51.1810], // Folkestone Downs
      [ 1.3162, 51.1279], // Dover (end)
    ],
  },

  // ── 3. Thames Path ────────────────────────────────────────────────────────
  {
    name: "Thames Path",
    slug: "thames-path",
    description:
      "A 185-mile National Trail following the River Thames from its source near Kemble in the Cotswolds to the Thames Barrier at Woolwich.",
    total_distance: 297_726,
    region: "South and Central England",
    waypoints: [
      [-2.0024, 51.6763], // Thames Head, Kemble (source)
      [-1.8567, 51.6405], // Cricklade
      [-1.6941, 51.6967], // Lechlade
      [-1.5769, 51.7135], // Newbridge
      [-1.4563, 51.7312], // Eynsham
      [-1.2596, 51.7521], // Oxford (Folly Bridge)
      [-1.2835, 51.6699], // Abingdon
      [-1.1838, 51.6427], // Clifton Hampden
      [-1.1250, 51.5998], // Wallingford
      [-1.0918, 51.4873], // Pangbourne
      [-0.9762, 51.4568], // Reading
      [-0.8984, 51.5360], // Henley-on-Thames
      [-0.7180, 51.5226], // Maidenhead
      [-0.6085, 51.4844], // Windsor
      [-0.5082, 51.4341], // Staines
      [-0.4111, 51.4590], // Walton-on-Thames
      [-0.3022, 51.4618], // Richmond
      [-0.2168, 51.4648], // Putney
      [-0.1206, 51.4980], // Lambeth Bridge
      [-0.0866, 51.5068], // London Bridge
      [-0.0027, 51.4826], // Greenwich
      [ 0.0679, 51.4905], // Woolwich (end)
    ],
  },

  // ── 4. Cotswold Way ───────────────────────────────────────────────────────
  {
    name: "Cotswold Way",
    slug: "cotswold-way",
    description:
      "A 102-mile National Trail running along the Cotswold escarpment from Bath to Chipping Campden, with sweeping views over the Severn Vale.",
    total_distance: 164_154,
    region: "South West England",
    waypoints: [
      [-2.3590, 51.3817], // Bath (start)
      [-2.4082, 51.4068], // Kelston Round Hill
      [-2.3830, 51.4128], // Lansdown
      [-2.2986, 51.4815], // Tormarton
      [-2.3373, 51.5425], // Old Sodbury
      [-2.3529, 51.6307], // Wotton-under-Edge
      [-2.3555, 51.6611], // North Nibley
      [-2.3535, 51.6827], // Dursley
      [-2.2509, 51.7259], // Selsley Common
      [-2.2173, 51.7544], // Stroud
      [-2.1716, 51.7949], // Painswick
      [-2.0785, 51.8381], // Birdlip
      [-2.0454, 51.9022], // Seven Springs
      [-1.9718, 51.9533], // Winchcombe
      [-1.9279, 51.9831], // Hailes Abbey
      [-1.8585, 52.0359], // Broadway
      [-1.7784, 52.0479], // Chipping Campden (end)
    ],
  },

  // ── 5. The Ridgeway ───────────────────────────────────────────────────────
  {
    name: "The Ridgeway",
    slug: "the-ridgeway",
    description:
      "An 87-mile ancient trackway from Avebury in Wiltshire to Ivinghoe Beacon in Buckinghamshire, one of Britain's oldest roads.",
    total_distance: 140_013,
    region: "South England",
    waypoints: [
      [-1.8549, 51.4285], // Avebury (start)
      [-1.7545, 51.5042], // Barbury Castle
      [-1.7277, 51.5039], // Ogbourne St George
      [-1.6711, 51.5558], // Liddington Hill
      [-1.5884, 51.5640], // Wayland's Smithy
      [-1.5706, 51.5773], // Uffington White Horse / Dragon Hill
      [-1.5036, 51.5669], // Sparsholt Firs
      [-1.4413, 51.5694], // Letcombe Bassett
      [-1.3710, 51.5850], // Scutchamer Knob
      [-1.2200, 51.5350], // East Ilsley Down
      [-1.1406, 51.5242], // Streatley / Goring (Thames crossing)
      [-1.0843, 51.5665], // Nuffield
      [-1.0007, 51.6497], // Watlington
      [-0.9051, 51.6936], // Chinnor
      [-0.8368, 51.7234], // Princes Risborough
      [-0.7433, 51.7589], // Wendover
      [-0.6580, 51.7954], // Tring
      [-0.6150, 51.8402], // Ivinghoe Beacon (end)
    ],
  },

  // ── 6. South West Coast Path ──────────────────────────────────────────────
  {
    name: "South West Coast Path",
    slug: "south-west-coast-path",
    description:
      "Britain's longest National Trail at 630 miles, hugging the coastline from Minehead in Somerset, around the entire peninsula of Devon and Cornwall, to Poole Harbour in Dorset.",
    total_distance: 1_014_193,
    region: "South West England",
    waypoints: [
      [-3.4757, 51.2039], // Minehead (start)
      [-3.6366, 51.2165], // Porlock Weir
      [-3.8349, 51.2293], // Lynmouth
      [-4.0339, 51.1997], // Combe Martin
      [-4.1180, 51.2076], // Ilfracombe
      [-4.2220, 51.1850], // Morte Point
      [-4.2297, 51.1234], // Croyde
      [-4.2364, 51.0291], // Westward Ho!
      [-4.5269, 51.0161], // Hartland Point
      [-4.5434, 50.8285], // Bude
      [-4.6956, 50.6912], // Boscastle
      [-4.7548, 50.6663], // Tintagel
      [-4.9397, 50.5411], // Padstow
      [-5.0803, 50.4154], // Newquay
      [-5.1549, 50.3433], // Perranporth
      [-5.4802, 50.2130], // St Ives
      [-5.6636, 50.1610], // Pendeen Watch
      [-5.7130, 50.0663], // Land's End
      [-5.5364, 50.0827], // Mousehole / Penzance area
      [-5.3183, 50.0836], // Porthleven
      [-5.2040, 49.9579], // Lizard Point (most southerly)
      [-5.0944, 50.0128], // Coverack
      [-5.0551, 50.1537], // Falmouth
      [-4.9183, 50.2199], // Gorran Haven
      [-4.7858, 50.2673], // Mevagissey
      [-4.6393, 50.3349], // Fowey
      [-4.4530, 50.3513], // Looe
      [-4.2226, 50.3121], // Rame Head
      [-4.1427, 50.3714], // Plymouth (ferry)
      [-3.9050, 50.2790], // Bigbury-on-Sea
      [-3.7770, 50.2381], // Salcombe
      [-3.7126, 50.1797], // Prawle Point (most southerly in Devon)
      [-3.5792, 50.3521], // Dartmouth
      [-3.5113, 50.3946], // Brixham
      [-3.5228, 50.4619], // Torquay
      [-3.4659, 50.5793], // Dawlish
      [-3.4137, 50.6193], // Exmouth
      [-3.2397, 50.6812], // Sidmouth
      [-3.0631, 50.7005], // Seaton
      [-2.9366, 50.7241], // Lyme Regis
      [-2.7573, 50.7062], // West Bay
      [-2.6044, 50.6698], // Abbotsbury
      [-2.4585, 50.6131], // Weymouth
      [-2.2733, 50.6209], // Durdle Door
      [-2.2449, 50.6193], // Lulworth Cove
      [-1.9578, 50.6080], // Swanage
      [-1.9564, 50.6424], // Studland
      [-1.9406, 50.7060], // South Haven Point, Poole Harbour (end)
    ],
  },

  // ── 7. Pennine Way ────────────────────────────────────────────────────────
  {
    name: "Pennine Way",
    slug: "pennine-way",
    description:
      "Britain's oldest National Trail, 268 miles along the backbone of England from Edale in the Peak District to Kirk Yetholm just over the Scottish border.",
    total_distance: 431_303,
    region: "Northern England",
    waypoints: [
      [-1.8152, 53.3665], // Edale (start)
      [-1.8708, 53.3859], // Kinder Scout
      [-1.8796, 53.4583], // Bleaklow Head
      [-1.9386, 53.4706], // Crowden (Longdendale)
      [-1.9220, 53.5389], // Black Hill
      [-1.9386, 53.5706], // Standedge
      [-2.0100, 53.7427], // Hebden Bridge area (Walshaw Dean)
      [-2.0808, 53.8957], // Pinhaw Beacon
      [-2.1595, 54.0664], // Malham
      [-2.1831, 54.1388], // Fountains Fell
      [-2.2407, 54.1580], // Pen-y-ghent
      [-2.3082, 54.1530], // Horton-in-Ribblesdale
      [-2.1982, 54.3066], // Hawes
      [-2.2157, 54.3666], // Great Shunner Fell
      [-2.1750, 54.3999], // Keld
      [-2.1539, 54.4498], // Tan Hill Inn
      [-2.0768, 54.6307], // Middleton-in-Teesdale
      [-2.1895, 54.6440], // High Force
      [-2.3380, 54.6666], // Cauldron Snout
      [-2.3842, 54.6726], // High Cup Nick
      [-2.4867, 54.7039], // Cross Fell
      [-2.4385, 54.8051], // Alston
      [-2.6139, 54.9898], // Hadrian's Wall (Thirlwall)
      [-2.5943, 54.9891], // Greenhead
      [-2.2555, 55.1438], // Bellingham
      [-2.2946, 55.3099], // Byrness
      [-2.3437, 55.4099], // Chew Green (Roman fort)
      [-2.2891, 55.4568], // Windy Gyle
      [-2.2154, 55.5554], // Kirk Yetholm (end)
    ],
  },

  // ── 8. Hadrian's Wall Path ────────────────────────────────────────────────
  {
    name: "Hadrian's Wall Path",
    slug: "hadrians-wall-path",
    description:
      "An 84-mile National Trail following the Roman frontier from Wallsend on Tyneside to Bowness-on-Solway on the Solway Firth.",
    total_distance: 135_185,
    region: "Northern England",
    waypoints: [
      [-1.5358, 54.9912], // Wallsend (Segedunum fort, start)
      [-1.6148, 54.9706], // Newcastle Quayside
      [-1.7658, 54.9863], // Denton
      [-1.8527, 54.9928], // Heddon-on-the-Wall
      [-1.9040, 54.9954], // Rudchester
      [-2.0354, 55.0097], // Portgate
      [-2.1330, 55.0134], // Chesters Fort (Cilurnum)
      [-2.2354, 55.0124], // Carrawburgh (Brocolitia)
      [-2.3719, 54.9947], // Housesteads (Vercovicium)
      [-2.4354, 54.9915], // Cawfields / Great Whin Sill
      [-2.5483, 54.9983], // Walltown Crags
      [-2.6054, 54.9983], // Gilsland
      [-2.6327, 54.9953], // Birdoswald Fort (Banna)
      [-2.7145, 54.9880], // Banks
      [-2.9381, 54.8951], // Carlisle (Luguvalium)
      [-3.0459, 54.9278], // Burgh by Sands
      [-3.1227, 54.9274], // Drumburgh
      [-3.2217, 54.9345], // Bowness-on-Solway (end)
    ],
  },

  // ── 9. Coast to Coast ─────────────────────────────────────────────────────
  {
    name: "Coast to Coast",
    slug: "coast-to-coast",
    description:
      "Alfred Wainwright's classic 192-mile walk from St Bees on the Irish Sea, through the Lake District, Yorkshire Dales and North York Moors, to Robin Hood's Bay on the North Sea.",
    total_distance: 308_984,
    region: "Northern England",
    waypoints: [
      [-3.6071, 54.4920], // St Bees (start)
      [-3.5101, 54.5212], // Cleator
      [-3.3862, 54.5280], // Ennerdale Bridge
      [-3.2038, 54.5183], // Honister Pass
      [-3.1580, 54.5254], // Rosthwaite (Borrowdale)
      [-3.0220, 54.4606], // Grasmere
      [-2.9377, 54.5377], // Patterdale
      [-2.8183, 54.5200], // Kidsty Pike
      [-2.6737, 54.5248], // Shap
      [-2.4825, 54.5045], // Orton
      [-2.3490, 54.4784], // Kirkby Stephen
      [-2.2388, 54.4253], // Nine Standards Rigg
      [-2.1750, 54.3999], // Keld
      [-1.9373, 54.3990], // Reeth
      [-1.7362, 54.4041], // Richmond
      [-1.5268, 54.3803], // Danby Wiske
      [-1.3461, 54.3765], // Ingleby Arncliffe
      [-1.1440, 54.3912], // Clay Bank Top
      [-0.9883, 54.4208], // Urra Moor
      [-0.8609, 54.4451], // Glaisdale
      [-0.7372, 54.4445], // Grosmont
      [-0.5299, 54.4341], // Robin Hood's Bay (end)
    ],
  },

  // ── 11. Cleveland Way ─────────────────────────────────────────────────────
  {
    name: "Cleveland Way",
    slug: "cleveland-way",
    description:
      "A 109-mile National Trail through the North York Moors from Helmsley, looping the moors escarpment and following the Heritage Coast south to Filey.",
    total_distance: 175_418,
    region: "North Yorkshire, England",
    waypoints: [
      [-1.0020, 54.2477], // Helmsley (start)
      [-1.2030, 54.3695], // Sutton Bank
      [-1.0450, 54.4500], // Osmotherley
      [-0.9120, 54.4609], // Clay Bank
      [-0.8609, 54.4451], // Glaisdale
      [-0.7372, 54.4445], // Grosmont
      [-0.5299, 54.4341], // Robin Hood's Bay
      [-0.4021, 54.3504], // Scarborough
      [-0.2976, 54.2107], // Filey (end)
    ],
  },

  // ── 12. Glyndŵr's Way ────────────────────────────────────────────────────
  {
    name: "Glyndŵr's Way",
    slug: "glyndwrs-way",
    description:
      "A 135-mile National Trail through the remote heart of mid-Wales, from Knighton to Welshpool via Machynlleth, named after the Welsh prince Owain Glyndŵr.",
    total_distance: 217_261,
    region: "Mid-Wales",
    waypoints: [
      [-3.0468, 52.3496], // Knighton (start)
      [-3.3154, 52.5126], // Llanbadarn Fynydd
      [-3.5095, 52.5582], // Llanidloes
      [-3.8549, 52.5905], // Machynlleth
      [-3.6864, 52.6680], // Lake Vyrnwy
      [-3.2962, 52.7232], // Llanfyllin
      [-3.1497, 52.6597], // Welshpool (end)
    ],
  },

  // ── 13. Great Glen Way ────────────────────────────────────────────────────
  {
    name: "Great Glen Way",
    slug: "great-glen-way",
    description:
      "A 79-mile Scottish long-distance route following the Great Glen fault from Fort William at the foot of Ben Nevis to Inverness on the Moray Firth.",
    total_distance: 127_138,
    region: "Scottish Highlands",
    waypoints: [
      [-5.1050, 56.8198], // Fort William (start)
      [-4.9731, 56.9629], // Gairlochy
      [-4.7963, 57.0003], // Laggan
      [-4.6800, 57.1435], // Fort Augustus
      [-4.5048, 57.2438], // Invermoriston
      [-4.4697, 57.3335], // Drumnadrochit
      [-4.2247, 57.4778], // Inverness (end)
    ],
  },

  // ── 14. Offa's Dyke Path ──────────────────────────────────────────────────
  {
    name: "Offa's Dyke Path",
    slug: "offas-dyke-path",
    description:
      "A 177-mile National Trail tracing the ancient earthwork built by King Offa of Mercia, following the English–Welsh border from Prestatyn on the north coast to Chepstow in the south.",
    total_distance: 284_854,
    region: "Wales/England Border",
    waypoints: [
      [-3.4046, 53.3350], // Prestatyn (start)
      [-3.1725, 52.9709], // Llangollen
      [-3.0800, 52.7727], // Welshpool
      [-3.0468, 52.3496], // Knighton
      [-2.9740, 52.2357], // Kington
      [-2.7960, 51.9620], // Hay-on-Wye
      [-2.9869, 51.8282], // Abergavenny area
      [-2.7149, 51.8131], // Monmouth
      [-2.6760, 51.6415], // Chepstow (end)
    ],
  },

  // ── 15. Peddars Way and Norfolk Coast Path ────────────────────────────────
  {
    name: "Peddars Way and Norfolk Coast Path",
    slug: "peddars-way-norfolk-coast",
    description:
      "A 130-mile National Trail through Norfolk: the ancient Peddars Way Roman road from Knettishall Heath to Holme-next-the-Sea, then the Norfolk Coast Path eastward along the Area of Outstanding Natural Beauty to Cromer.",
    total_distance: 209_215,
    region: "Norfolk, England",
    waypoints: [
      [ 0.9030, 52.3737], // Knettishall Heath (start)
      [ 0.7979, 52.5190], // Thompson
      [ 0.6841, 52.7006], // Castle Acre
      [ 0.4799, 52.8547], // Sedgeford
      [ 0.4942, 52.9385], // Holme-next-the-Sea
      [ 0.5307, 52.9617], // Burnham Deepdale
      [ 0.8544, 52.9567], // Wells-next-the-Sea
      [ 1.0616, 52.9546], // Blakeney
      [ 1.1810, 52.9379], // Sheringham
      [ 1.3018, 52.9318], // Cromer (end)
    ],
  },

  // ── 16. Pembrokeshire Coast Path ──────────────────────────────────────────
  {
    name: "Pembrokeshire Coast Path",
    slug: "pembrokeshire-coast-path",
    description:
      "A 186-mile National Trail tracing the dramatic Pembrokeshire coastline from Amroth in the south, around the rugged St David's Peninsula, to St Dogmaels near Cardigan in the north.",
    total_distance: 299_338,
    region: "Pembrokeshire, Wales",
    waypoints: [
      [-4.7072, 51.7364], // Amroth (start)
      [-4.9164, 51.6741], // Pembroke
      [-5.0872, 51.6922], // Angle
      [-5.3027, 51.8091], // Marloes
      [-5.2682, 51.8808], // St David's
      [-5.0543, 51.9493], // Fishguard
      [-4.8404, 51.9989], // Newport
      [-4.6927, 52.0841], // St Dogmaels (end)
    ],
  },

  // ── 17. Pennine Bridleway ─────────────────────────────────────────────────
  {
    name: "Pennine Bridleway",
    slug: "pennine-bridleway",
    description:
      "A 205-mile National Trail for horse riders, cyclists and walkers running the length of the Pennines from Middleton Top in Derbyshire to Byrness in Northumberland.",
    total_distance: 329_915,
    region: "Northern England",
    waypoints: [
      [-1.5671, 53.1055], // Middleton Top, Derbyshire (start)
      [-1.9386, 53.5706], // Standedge
      [-2.0100, 53.7427], // Walshaw Dean
      [-2.1595, 54.0664], // Malham
      [-2.1750, 54.3999], // Keld
      [-2.1539, 54.4498], // Tan Hill
      [-2.3380, 54.6666], // Cauldron Snout area
      [-2.4385, 54.8051], // Alston
      [-2.2946, 55.3099], // Byrness (end)
    ],
  },

  // ── 18. Southern Upland Way ───────────────────────────────────────────────
  {
    name: "Southern Upland Way",
    slug: "southern-upland-way",
    description:
      "Scotland's first official long-distance route, 214 miles coast-to-coast from Portpatrick on the Irish Sea shore to Cockburnspath on the North Sea, crossing the remote Southern Upland hills.",
    total_distance: 344_400,
    region: "Southern Scotland",
    waypoints: [
      [-5.1194, 54.8405], // Portpatrick (start)
      [-4.5800, 55.1500], // Castle Kennedy
      [-3.9226, 55.3687], // Sanquhar
      [-3.4431, 55.3379], // Moffat
      [-3.0668, 55.6205], // Innerleithen
      [-2.7237, 55.5990], // Melrose
      [-2.5580, 55.7185], // Lauder
      [-2.3615, 55.9437], // Cockburnspath (end)
    ],
  },

  // ── 19. Speyside Way ─────────────────────────────────────────────────────
  {
    name: "Speyside Way",
    slug: "speyside-way",
    description:
      "A 65-mile Scottish long-distance route following the valley of the River Spey from Buckie on the Moray coast through whisky country to Aviemore in the Cairngorms National Park.",
    total_distance: 104_607,
    region: "Moray and Cairngorms, Scotland",
    waypoints: [
      [-2.9677, 57.6762], // Buckie (start)
      [-3.1989, 57.4618], // Craigellachie
      [-3.3460, 57.4097], // Aberlour
      [-3.4711, 57.3774], // Grantown-on-Spey area
      [-3.6253, 57.3294], // Cromdale
      [-3.8236, 57.1956], // Aviemore (end)
    ],
  },

  // ── 20. Yorkshire Wolds Way ───────────────────────────────────────────────
  {
    name: "Yorkshire Wolds Way",
    slug: "yorkshire-wolds-way",
    description:
      "A 79-mile National Trail from the Humber estuary at Hessle, across the rolling chalk hills of the Yorkshire Wolds, to the clifftop at Filey Brigg on the North Sea coast.",
    total_distance: 127_138,
    region: "East Yorkshire, England",
    waypoints: [
      [-0.4356, 53.7197], // Hessle (start)
      [-0.5432, 53.7854], // Brough
      [-0.6684, 53.8659], // Market Weighton
      [-0.7001, 53.9629], // Millington
      [-0.6505, 54.0268], // Thixendale
      [-0.5488, 54.1108], // Duggleby Howe
      [-0.4010, 54.1879], // Sherburn
      [-0.2976, 54.2107], // Filey (end)
    ],
  },

  // ── 10. West Highland Way ─────────────────────────────────────────────────
  {
    name: "West Highland Way",
    slug: "west-highland-way",
    description:
      "Scotland's first long-distance route, 96 miles from Milngavie on the outskirts of Glasgow north to Fort William at the foot of Ben Nevis.",
    total_distance: 154_497,
    region: "Scotland",
    waypoints: [
      [-4.3133, 55.9411], // Milngavie (start)
      [-4.3547, 55.9741], // Carbeth
      [-4.4332, 56.0782], // Drymen
      [-4.5426, 56.0917], // Balmaha (Loch Lomond shore)
      [-4.5778, 56.1190], // Rowardennan
      [-4.6069, 56.1564], // Ptarmigan Lodge
      [-4.6928, 56.2469], // Inversnaid
      [-4.7214, 56.3197], // Inverarnan
      [-4.6174, 56.3893], // Crianlarich
      [-4.7172, 56.4338], // Tyndrum
      [-4.7564, 56.5215], // Bridge of Orchy
      [-4.8847, 56.5956], // Ba Bridge (Rannoch Moor)
      [-4.8718, 56.6541], // Kingshouse Hotel
      [-4.9601, 56.6905], // Devil's Staircase (Altnafeadh)
      [-4.9617, 56.7122], // Kinlochleven
      [-5.0323, 56.7598], // Lairigmor
      [-5.1050, 56.8198], // Fort William (end)
    ],
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function toWKT(waypoints) {
  return `LINESTRING(${waypoints.map(([lng, lat]) => `${lng} ${lat}`).join(", ")})`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

const pool = new Pool({
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15_000,
});

console.log("Connecting to database…");

try {
  const client = await pool.connect();
  console.log(`Connected to ${process.env.PGHOST}/${process.env.PGDATABASE}\n`);

  let upserted = 0;

  for (const trail of trails) {
    const start = trail.waypoints[0];
    const end = trail.waypoints[trail.waypoints.length - 1];
    const wkt = toWKT(trail.waypoints);

    await client.query(
      `INSERT INTO trails (
         name, slug, description, total_distance, region,
         start_point, end_point, geometry
       ) VALUES (
         $1, $2, $3, $4, $5,
         ST_SetSRID(ST_MakePoint($6, $7), 4326),
         ST_SetSRID(ST_MakePoint($8, $9), 4326),
         ST_GeomFromText($10, 4326)
       )
       ON CONFLICT (slug) DO UPDATE SET
         name           = EXCLUDED.name,
         description    = EXCLUDED.description,
         total_distance = EXCLUDED.total_distance,
         region         = EXCLUDED.region,
         start_point    = EXCLUDED.start_point,
         end_point      = EXCLUDED.end_point,
         geometry       = EXCLUDED.geometry,
         updated_at     = NOW()`,
      [
        trail.name,
        trail.slug,
        trail.description,
        trail.total_distance,
        trail.region,
        start[0], start[1],   // start lng, lat
        end[0],   end[1],     // end   lng, lat
        wkt,
      ]
    );

    console.log(`  ✓ ${trail.name} (${trail.waypoints.length} waypoints)`);
    upserted++;
  }

  client.release();
  console.log(`\n✓ Done — ${upserted} trails upserted.`);
} catch (err) {
  console.error("✗ Seed failed:", err.message);
  if (err.detail) console.error("  Detail:", err.detail);
  process.exit(1);
} finally {
  await pool.end();
}
