import * as cron from 'node-cron';
import { db } from '../db';
import { 
  recipes, recipeSources, recipeIngredients, ingredients, stores,
  flyerPromotions, referencePrices, recipeStorePrices, unifiedPrices,
  ingredientEquivalences
} from '@shared/schema';
import { eq, and, gte, inArray, desc, sql, isNotNull } from 'drizzle-orm';
import { STORE_IDS } from './types';

// Cache for ingredient equivalences from database
let ingredientEquivalenceCache: Map<string, { toQuantity: number; toUnit: string }> = new Map();
let lastEquivalenceCacheLoad = 0;
const EQUIVALENCE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function loadIngredientEquivalences(): Promise<void> {
  const now = Date.now();
  if (now - lastEquivalenceCacheLoad < EQUIVALENCE_CACHE_TTL && ingredientEquivalenceCache.size > 0) {
    return; // Use cached data
  }
  
  try {
    const equivalences = await db
      .select({
        ingredientId: ingredientEquivalences.ingredientId,
        ingredientName: ingredients.name,
        toQuantity: ingredientEquivalences.toQuantity,
        toUnit: ingredientEquivalences.toUnit,
      })
      .from(ingredientEquivalences)
      .innerJoin(ingredients, eq(ingredientEquivalences.ingredientId, ingredients.id))
      .where(isNotNull(ingredientEquivalences.toQuantity));
    
    ingredientEquivalenceCache.clear();
    for (const eq of equivalences) {
      if (eq.toQuantity !== null && eq.toUnit) {
        // Store by normalized ingredient name for matching
        const normalizedName = normalizeText(eq.ingredientName);
        ingredientEquivalenceCache.set(normalizedName, {
          toQuantity: eq.toQuantity,
          toUnit: eq.toUnit,
        });
      }
    }
    
    lastEquivalenceCacheLoad = now;
    console.log(`[EquivalenceCache] Loaded ${ingredientEquivalenceCache.size} ingredient equivalences`);
  } catch (error) {
    console.error('[EquivalenceCache] Failed to load equivalences:', error);
  }
}

// Get weight/volume from database equivalences first, then fallback to static dictionary
function getUnitWeightFromEquivalences(ingredientName: string): number | null {
  const normalized = normalizeText(ingredientName);
  
  // Check database cache first
  const dbEquivalence = ingredientEquivalenceCache.get(normalized);
  if (dbEquivalence && dbEquivalence.toUnit === 'g') {
    return dbEquivalence.toQuantity;
  }
  
  // Partial matching for database cache
  for (const [key, value] of Array.from(ingredientEquivalenceCache.entries())) {
    if (value.toUnit === 'g' && (normalized.includes(key) || key.includes(normalized))) {
      return value.toQuantity;
    }
  }
  
  return null;
}

let isCalculating = false;
let calculationStartTime: number | null = null;
let calculationTask: cron.ScheduledTask | null = null;

// Auto-reset if calculation takes more than 10 minutes (stuck state)
const MAX_CALCULATION_TIME_MS = 10 * 60 * 1000;

// Force reset the calculating flag (for admin use)
export function forceResetCalculationFlag(): void {
  console.log('[RecipePriceCalculation] Force resetting isCalculating flag');
  isCalculating = false;
  calculationStartTime = null;
}

interface IngredientPricingResult {
  ingredientName: string;
  price: number;
  source: 'unified' | 'promo' | 'reference' | 'estimate';
}

// Extended breakdown with calculated cost for each ingredient
interface IngredientBreakdownItem {
  ingredientId: string;
  ingredientName: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  priceUnit?: string; // 'kg', 'l', or 'unité' - for display in frontend
  calculatedCost: number;
  source: 'unified' | 'promo' | 'reference' | 'estimate';
}

interface UnifiedPriceData {
  genericProduct: string | null;
  regularPrice: number | null;
  salePrice: number | null;
  unitPrice: number | null;
  quantity: number;
  unit: string;
}

interface CachedStoreData {
  unified: UnifiedPriceData[];
  promos: Array<{ productName: string; promoPrice: number }>;
  refs: Array<{ productName: string; price: number }>;
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function getWeekStart(): string {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const diff = now.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
  const monday = new Date(now.setDate(diff));
  return monday.toISOString().split('T')[0];
}

const categoryEstimates: Record<string, number> = {
  'Viandes': 8.99,
  'Poissons': 12.99,
  'Produits laitiers': 4.99,
  'Fruits et légumes': 2.99,
  'Boulangerie': 3.49,
  'Épicerie': 3.99,
  'Surgelés': 5.99,
};

// Conversion d'unités de recette vers ml ou g
const UNIT_TO_ML: Record<string, number> = {
  'c. à soupe': 15,
  'c.s.': 15,
  'tbsp': 15,
  'cuillère à soupe': 15,
  'cuilleres a soupe': 15,
  'c. à thé': 5,
  'c.t.': 5,
  'tsp': 5,
  'cuillère à thé': 5,
  'cuilleres a the': 5,
  'tasse': 250,
  'tasses': 250,
  'cup': 250,
  'cups': 250,
  'ml': 1,
  'millilitre': 1,
  'millilitres': 1,
  'cl': 10,
  'centilitre': 10,
  'centilitres': 10,
  'l': 1000,
  'litre': 1000,
  'litres': 1000,
};

const UNIT_TO_G: Record<string, number> = {
  'g': 1,
  'gramme': 1,
  'grammes': 1,
  'kg': 1000,
  'kilogramme': 1000,
  'kilogrammes': 1000,
  // ADD OBJECTIVE 4: Imperial Conversions
  // AJOUT OBJECTIF 4 : Conversions impériales
  'lb': 454,
  'lbs': 454,
  'livre': 454,
  'livres': 454,
  'oz': 28.35,
  'once': 28.35,
  'onces': 28.35,
  'pincée': 0.5,
  'pincee': 0.5,
  'pinch': 0.5,
};

// Tailles de produits standard en ml ou g (ce qu'on achète à l'épicerie)
const PRODUCT_STANDARD_SIZES: Record<string, { size: number; unit: 'ml' | 'g' }> = {
  // Huiles et liquides (en ml)
  'huile': { size: 750, unit: 'ml' },
  'huile d\'olive': { size: 750, unit: 'ml' },
  'huile olive': { size: 750, unit: 'ml' },
  'huile végétale': { size: 946, unit: 'ml' },
  'huile vegetale': { size: 946, unit: 'ml' },
  'huile de canola': { size: 946, unit: 'ml' },
  'vinaigre': { size: 500, unit: 'ml' },
  'vinaigre balsamique': { size: 250, unit: 'ml' },
  'sauce soya': { size: 450, unit: 'ml' },
  'sauce soja': { size: 450, unit: 'ml' },
  'sirop d\'érable': { size: 540, unit: 'ml' },
  'sirop erable': { size: 540, unit: 'ml' },
  'miel': { size: 500, unit: 'ml' },
  'lait': { size: 2000, unit: 'ml' },
  'crème': { size: 473, unit: 'ml' },
  'creme': { size: 473, unit: 'ml' },
  'bouillon': { size: 900, unit: 'ml' },
  
  // Condiments (en ml ou g)
  'moutarde': { size: 250, unit: 'ml' },
  'moutarde de dijon': { size: 250, unit: 'ml' },
  'mayonnaise': { size: 450, unit: 'ml' },
  'ketchup': { size: 750, unit: 'ml' },
  'sriracha': { size: 480, unit: 'ml' },
  'sauce piquante': { size: 150, unit: 'ml' },
  'tabasco': { size: 60, unit: 'ml' },
  'sambal': { size: 200, unit: 'ml' },
  'pâte de tomate': { size: 156, unit: 'ml' },
  'pate de tomate': { size: 156, unit: 'ml' },
  'pâte de tomates': { size: 156, unit: 'ml' },
  'pate de tomates': { size: 156, unit: 'ml' },
  'vin': { size: 750, unit: 'ml' },
  'vin rouge': { size: 750, unit: 'ml' },
  'vin blanc': { size: 750, unit: 'ml' },
  'bouillon de boeuf': { size: 900, unit: 'ml' },
  'bouillon de poulet': { size: 900, unit: 'ml' },
  'bouillon de légumes': { size: 900, unit: 'ml' },
  'bouillon de legumes': { size: 900, unit: 'ml' },
  
  // Épices et herbes (en g)
  'paprika': { size: 50, unit: 'g' },
  'paprika fumé': { size: 50, unit: 'g' },
  'paprika fume': { size: 50, unit: 'g' },
  'cumin': { size: 50, unit: 'g' },
  'origan': { size: 25, unit: 'g' },
  'oregano': { size: 25, unit: 'g' },
  'thym': { size: 25, unit: 'g' },
  'thym frais': { size: 25, unit: 'g' },
  'feuille de laurier': { size: 10, unit: 'g' },
  'feuilles de laurier': { size: 10, unit: 'g' },
  'laurier': { size: 10, unit: 'g' },
  'basilic': { size: 250, unit: 'ml' },  // 1 contenant d'herbes fraîches ~250ml (équiv. ~25g)
  'basilic frais': { size: 250, unit: 'ml' },
  'basilic haché': { size: 250, unit: 'ml' },
  'romarin': { size: 250, unit: 'ml' },
  'romarin frais': { size: 250, unit: 'ml' },
  'persil': { size: 250, unit: 'ml' },
  'persil frais': { size: 250, unit: 'ml' },
  'persil haché': { size: 250, unit: 'ml' },
  'coriandre': { size: 250, unit: 'ml' },
  'coriandre fraîche': { size: 250, unit: 'ml' },
  'coriandre fraiche': { size: 250, unit: 'ml' },
  'coriandre hachée': { size: 250, unit: 'ml' },
  'coriandre hachee': { size: 250, unit: 'ml' },
  'menthe': { size: 250, unit: 'ml' },
  'menthe fraîche': { size: 250, unit: 'ml' },
  'menthe fraiche': { size: 250, unit: 'ml' },
  'ciboulette': { size: 250, unit: 'ml' },
  'aneth': { size: 250, unit: 'ml' },
  'cannelle': { size: 50, unit: 'g' },
  'muscade': { size: 30, unit: 'g' },
  'poivre': { size: 50, unit: 'g' },
  'sel': { size: 500, unit: 'g' },
  'ail en poudre': { size: 50, unit: 'g' },
  'poudre d\'ail': { size: 50, unit: 'g' },
  'oignon en poudre': { size: 50, unit: 'g' },
  'poudre d\'oignon': { size: 50, unit: 'g' },
  'herbes de provence': { size: 30, unit: 'g' },
  'épices italiennes': { size: 30, unit: 'g' },
  'epices italiennes': { size: 30, unit: 'g' },
  'cari': { size: 50, unit: 'g' },
  'curry': { size: 50, unit: 'g' },
  'gingembre moulu': { size: 40, unit: 'g' },
  'piment': { size: 40, unit: 'g' },
  'cayenne': { size: 40, unit: 'g' },
  
  // Produits secs (en g)
  'farine': { size: 2500, unit: 'g' },
  'sucre': { size: 2000, unit: 'g' },
  'cassonade': { size: 1000, unit: 'g' },
  'riz': { size: 900, unit: 'g' },
  'pâtes': { size: 450, unit: 'g' },
  'pates': { size: 450, unit: 'g' },
  'spaghetti': { size: 450, unit: 'g' },
  'quinoa': { size: 400, unit: 'g' },
  'avoine': { size: 1000, unit: 'g' },
  'chapelure': { size: 425, unit: 'g' },
  
  // Produits laitiers
  'beurre': { size: 454, unit: 'g' },
  'fromage': { size: 400, unit: 'g' },
  'parmesan': { size: 200, unit: 'g' },
  'yogourt': { size: 650, unit: 'g' },
  'crème fraîche': { size: 250, unit: 'ml' },
  'creme fraiche': { size: 250, unit: 'ml' },
  'crème sure': { size: 500, unit: 'ml' },
  'creme sure': { size: 500, unit: 'ml' },
};

// Ingrédients qu'on achète à l'unité (pas de calcul proportionnel)
const UNIT_BASED_INGREDIENTS = new Set([
  'oeuf', 'oeufs', 'oeuf', 'œuf', 'œufs',
  'oignon', 'oignons',
  'oignon vert', 'oignons verts', 'échalote verte', 'echalote verte',
  'ail', 'gousse d\'ail', 'gousses d\'ail',
  'citron', 'citrons',
  'lime', 'limes',
  'orange', 'oranges',
  'pomme', 'pommes',
  'banane', 'bananes',
  'avocat', 'avocats',
  'tomate', 'tomates',
  'poivron', 'poivrons',
  'concombre', 'concombres',
  'carotte', 'carottes',
  'pomme de terre', 'pommes de terre', 'patate', 'patates',
  'poulet', 'poitrine de poulet', 'cuisse de poulet',
  'pain', 'baguette',
  'piment', 'piment oiseau', 'jalapeño', 'jalapeno',
]);

// Poids par "unité" pour les ingrédients vendus à l'unité (en grammes)
// Utilisé quand la recette demande "X unité" et le prix est en $/kg
const UNIT_WEIGHT_IN_GRAMS: Record<string, number> = {
  'ail': 5,           // 1 gousse d'ail ≈ 5g
  'gousse d\'ail': 5,
  'gousses d\'ail': 5,
  'oignon': 150,      // 1 oignon moyen ≈ 150g
  'oignons': 150,
  'oeuf': 50,         // 1 oeuf ≈ 50g
  'oeufs': 50,
  'citron': 100,      // 1 citron ≈ 100g
  'citrons': 100,
  'lime': 70,         // 1 lime ≈ 70g
  'limes': 70,
  'orange': 180,      // 1 orange ≈ 180g
  'oranges': 180,
  'pomme': 180,       // 1 pomme ≈ 180g
  'pommes': 180,
  'banane': 120,      // 1 banane ≈ 120g
  'bananes': 120,
  'avocat': 200,      // 1 avocat ≈ 200g
  'avocats': 200,
  'tomate': 150,      // 1 tomate ≈ 150g
  'tomates': 150,
  'poivron': 150,     // 1 poivron ≈ 150g
  'poivrons': 150,
  'concombre': 300,   // 1 concombre ≈ 300g
  'concombres': 300,
  'carotte': 80,      // 1 carotte ≈ 80g
  'carottes': 80,
  'pomme de terre': 200,  // 1 pomme de terre ≈ 200g
  'pommes de terre': 200,
  'patate': 200,
  'patates': 200,
  // Herbes fraîches vendues par bouquet/unité
  'thym frais': 10,       // 1 bouquet de thym ≈ 10g
  'thym': 10,
  'feuille de laurier': 0.3,  // 1 feuille de laurier ≈ 0.3g
  'feuilles de laurier': 0.3,
  'laurier': 0.3,
  'basilic frais': 15,    // 1 bouquet de basilic ≈ 15g
  'romarin frais': 10,    // 1 branche de romarin ≈ 10g
  'romarin': 10,
  'persil frais': 15,     // 1 bouquet de persil ≈ 15g
  'persil': 15,
  'coriandre fraîche': 15, // 1 bouquet de coriandre ≈ 15g
  'coriandre fraiche': 15,
  'coriandre': 15,
  'menthe fraîche': 10,   // 1 bouquet de menthe ≈ 10g
  'menthe fraiche': 10,
  'menthe': 10,
  // Légumes vendus en botte/paquet
  'oignon vert': 15,      // 1 tige d'oignon vert ≈ 15g
  'oignons verts': 15,
  'échalote verte': 15,
  'echalote verte': 15,
  'piment oiseau': 5,     // 1 petit piment ≈ 5g
  'piment': 10,           // 1 piment moyen ≈ 10g
  'jalapeño': 15,         // 1 jalapeño ≈ 15g
  'jalapeno': 15,
  // Gingembre
  'gingembre': 10,        // 1 morceau (2.5cm) ≈ 10g
  'gingembre frais': 10,
  // Échalotes
  'échalote': 30,         // 1 échalote ≈ 30g
  'echalote': 30,
  // Légumes verts
  'brocoli': 300,         // 1 brocoli ≈ 300g
  'laitue': 400,          // 1 laitue ≈ 400g
  'chou': 500,            // 1 chou ≈ 500g
  'chou-fleur': 500,
  'courgette': 200,       // 1 courgette ≈ 200g
  'courgettes': 200,
  'céleri': 40,           // 1 branche ≈ 40g
  'celeri': 40,
  'champignon': 20,       // 1 champignon ≈ 20g
  'champignons': 20,
};

// Obtenir le poids en grammes pour 1 "unité" d'un ingrédient
// Priority: 1. Database equivalences, 2. Static dictionary
function getUnitWeightInGrams(ingredientName: string): number | null {
  // Try database equivalences first (cached)
  const dbWeight = getUnitWeightFromEquivalences(ingredientName);
  if (dbWeight !== null) {
    return dbWeight;
  }
  
  // Fallback to static dictionary
  const normalized = normalizeText(ingredientName);
  
  for (const [key, weight] of Object.entries(UNIT_WEIGHT_IN_GRAMS)) {
    const keyNorm = normalizeText(key);
    if (normalized === keyNorm || normalized.includes(keyNorm) || keyNorm.includes(normalized)) {
      return weight;
    }
  }
  
  return null;
}

function getProductStandardSize(ingredientName: string): { size: number; unit: 'ml' | 'g' } | null {
  const normalized = normalizeText(ingredientName);
  
  // Chercher une correspondance exacte d'abord
  for (const [key, value] of Object.entries(PRODUCT_STANDARD_SIZES)) {
    if (normalizeText(key) === normalized) {
      return value;
    }
  }
  
  // Chercher une correspondance partielle
  for (const [key, value] of Object.entries(PRODUCT_STANDARD_SIZES)) {
    const keyNorm = normalizeText(key);
    if (normalized.includes(keyNorm) || keyNorm.includes(normalized)) {
      return value;
    }
  }
  
  return null;
}

function isUnitBasedIngredient(ingredientName: string): boolean {
  const normalized = normalizeText(ingredientName);
  const unitItems = Array.from(UNIT_BASED_INGREDIENTS);
  for (const item of unitItems) {
    if (normalized.includes(normalizeText(item)) || normalizeText(item).includes(normalized)) {
      return true;
    }
  }
  return false;
}

// Vérifier si l'unité est une mesure de poids ou volume
function isWeightOrVolumeUnit(unit: string): boolean {
  const u = unit.toLowerCase().trim();
  const weightUnits = ['g', 'kg', 'gramme', 'grammes', 'kilogramme', 'kilogrammes', 'lb', 'lbs', 'oz'];
  const volumeUnits = ['ml', 'l', 'cl', 'millilitre', 'millilitres', 'litre', 'litres', 'centilitre', 'centilitres',
    'c. à soupe', 'c.s.', 'tbsp', 'cuillère à soupe', 'cuilleres a soupe',
    'c. à thé', 'c.t.', 'tsp', 'cuillère à thé', 'cuilleres a the',
    'tasse', 'tasses', 'cup', 'cups'];
  return weightUnits.includes(u) || volumeUnits.includes(u);
}

function calculateProportionalCost(
  quantity: number,
  unit: string,
  productPrice: number,
  ingredientName: string
): number {
  const unitLower = unit.toLowerCase().trim();
  
  // Si l'unité est une mesure de poids/volume, NE PAS traiter comme vendu à l'unité
  // même si le nom de l'ingrédient est dans UNIT_BASED_INGREDIENTS
  const hasWeightVolumeUnit = isWeightOrVolumeUnit(unitLower);
  
  // Vérifier si c'est une unité de comptage (gousses, branches, etc.)
  const isCountingUnit = ['gousse', 'gousses', 'branche', 'branches', 'tige', 'tiges', 
                          'feuille', 'feuilles', 'tranche', 'tranches', 'morceau', 'morceaux',
                          'unité', 'unités', 'pièce', 'pièces', ''].includes(unitLower);
  
  // Pour les ingrédients vendus à l'unité avec unités de comptage
  // CORRECTION: Utiliser le poids par unité pour calculer proportionnellement
  if (!hasWeightVolumeUnit && (isUnitBasedIngredient(ingredientName) || isCountingUnit)) {
    const unitWeight = getUnitWeightInGrams(ingredientName);
    
    if (unitWeight !== null) {
      // On connaît le poids par unité - calculer proportionnellement
      const totalWeightNeeded = quantity * unitWeight; // en grammes
      
      // Estimer la taille du paquet et déterminer si c'est un prix unitaire selon le type d'ingrédient
      // IMPORTANT: Les seuils de prix varient selon l'ingrédient!
      let packageSizeGrams = 500; // défaut 500g
      let isProbablyPerItemPrice = false;
      const normalized = normalizeText(ingredientName);
      
      if (normalized.includes('ail') || normalized.includes('gousse')) {
        // AIL: $2-4 = une tête (~50g contenant ~10 gousses)
        // Jamais vendu "à la gousse" - toujours calculer proportionnellement
        packageSizeGrams = 50; // tête d'ail ~50g
        isProbablyPerItemPrice = false; // TOUJOURS proportionnel pour l'ail
      } else if (normalized.includes('oignon vert') || normalized.includes('oignons vert') || 
                 normalized.includes('oignons verts') || normalized.includes('echalote verte') || 
                 normalized.includes('echalotes verte') || normalized.includes('echalotes vertes')) {
        packageSizeGrams = 100; // botte d'oignons verts ~100g (6-8 tiges)
        isProbablyPerItemPrice = false;
      } else if (normalized.includes('herbe') || normalized.includes('thym') || 
                 normalized.includes('romarin') || normalized.includes('basilic') ||
                 normalized.includes('persil') || normalized.includes('coriandre') ||
                 normalized.includes('menthe') || normalized.includes('laurier')) {
        packageSizeGrams = 30; // bouquet d'herbes ~30g
        isProbablyPerItemPrice = false; // Herbes vendues en botte
      } else if (normalized.includes('carotte')) {
        // CAROTTES: < $0.50 = à l'unité, $2-4 = sac de 2lb (1000g)
        isProbablyPerItemPrice = productPrice < 0.80;
        packageSizeGrams = isProbablyPerItemPrice ? 80 : 1000;
      } else if (normalized.includes('oignon') && !normalized.includes('vert')) {
        // OIGNONS: < $0.50 = à l'unité, $2-4 = sac de 3lb (1500g)
        isProbablyPerItemPrice = productPrice < 0.80;
        packageSizeGrams = isProbablyPerItemPrice ? 150 : 1500;
      } else if (normalized.includes('pomme') && normalized.includes('terre') || 
                 normalized.includes('patate')) {
        // POMMES DE TERRE: < $0.50 = à l'unité, $3-6 = sac de 5lb (2000g)
        isProbablyPerItemPrice = productPrice < 0.80;
        packageSizeGrams = isProbablyPerItemPrice ? 200 : 2000;
      } else if (normalized.includes('citron') || normalized.includes('lime')) {
        // CITRONS/LIMES: < $1.50 = à l'unité (typiquement $0.50-1.00)
        isProbablyPerItemPrice = productPrice < 1.50;
        packageSizeGrams = isProbablyPerItemPrice ? 100 : 1000;
      } else if (normalized.includes('orange')) {
        // ORANGES: < $1.50 = à l'unité
        isProbablyPerItemPrice = productPrice < 1.50;
        packageSizeGrams = isProbablyPerItemPrice ? 180 : 1000;
      } else if (normalized.includes('piment') || normalized.includes('jalapeno')) {
        packageSizeGrams = 100; // paquet de piments ~100g
        isProbablyPerItemPrice = false;
      } else if (normalized.includes('banane')) {
        // BANANES: vendues au poids au Québec, prix/kg typique $1.50-2.50
        isProbablyPerItemPrice = productPrice < 1.00;
        packageSizeGrams = isProbablyPerItemPrice ? 120 : 1000;
      } else if (normalized.includes('pomme') && !normalized.includes('terre')) {
        // POMMES (fruits): < $1.50 = à l'unité
        isProbablyPerItemPrice = productPrice < 1.50;
        packageSizeGrams = isProbablyPerItemPrice ? 180 : 1000;
      } else if (normalized.includes('tomate')) {
        // TOMATES: < $1.50 = à l'unité
        isProbablyPerItemPrice = productPrice < 1.50;
        packageSizeGrams = isProbablyPerItemPrice ? 150 : 1000;
      } else if (normalized.includes('avocat')) {
        // AVOCATS: typiquement $1-2 à l'unité
        isProbablyPerItemPrice = productPrice < 3.00;
        packageSizeGrams = isProbablyPerItemPrice ? 200 : 600;
      } else if (normalized.includes('concombre')) {
        // CONCOMBRES: < $1.50 = à l'unité
        isProbablyPerItemPrice = productPrice < 1.50;
        packageSizeGrams = isProbablyPerItemPrice ? 300 : 600;
      } else if (normalized.includes('poivron')) {
        // POIVRONS: < $1.50 = à l'unité
        isProbablyPerItemPrice = productPrice < 1.50;
        packageSizeGrams = isProbablyPerItemPrice ? 150 : 500;
      } else if (normalized.includes('celeri')) {
        // CÉLERI: vendu en pied, pas à la branche
        packageSizeGrams = 500; // pied de céleri ~500g
        isProbablyPerItemPrice = false;
      }
      
      // Calculer le coût en fonction du type de prix
      let cost: number;
      
      if (isProbablyPerItemPrice) {
        // Prix à l'unité: simplement multiplier par la quantité
        // Ex: 10 citrons à $0.50 chacun = $5.00
        cost = productPrice * quantity;
        console.log(`[PriceCalc] ${ingredientName}: ${quantity} ${unit} × $${productPrice}/unité = $${cost.toFixed(2)} (prix unitaire)`);
      } else {
        // Prix au paquet: calculer la proportion utilisée
        const proportion = totalWeightNeeded / packageSizeGrams;
        cost = productPrice * proportion;
        
        // Le coût proportionnel ne peut pas dépasser le prix d'un paquet
        // (mais peut dépasser si on a besoin de plus d'un paquet)
        const numPackagesNeeded = Math.ceil(proportion);
        cost = Math.min(cost, productPrice * numPackagesNeeded);
        
        console.log(`[PriceCalc] ${ingredientName}: ${quantity} ${unit} × ${unitWeight}g = ${totalWeightNeeded}g / ${packageSizeGrams}g paquet = ${proportion.toFixed(3)} × $${productPrice} = $${cost.toFixed(2)}`);
      }
      
      return Math.max(0.01, Math.round(cost * 100) / 100);
    }
    
    // Pas de poids connu - traiter comme unité entière mais avec un maximum raisonnable
    // Ne JAMAIS multiplier par plus de 2 paquets pour des ingrédients courants
    const multiplier = Math.min(Math.ceil(quantity), 2);
    console.log(`[PriceCalc] ${ingredientName}: ${quantity} ${unit} - poids inconnu, utilise ${multiplier} paquet(s) × $${productPrice}`);
    return productPrice * multiplier;
  }
  
  // Obtenir la taille standard du produit
  let standardSize = getProductStandardSize(ingredientName);
  
  // Si pas de taille standard mais on a une unité de poids/volume, estimer
  if (!standardSize && hasWeightVolumeUnit) {
    // Assumer des tailles par défaut selon le type de produit
    const normalized = normalizeText(ingredientName);
    if (normalized.includes('poulet') || normalized.includes('boeuf') || 
        normalized.includes('porc') || normalized.includes('viande') ||
        normalized.includes('jambon') || normalized.includes('saucisse') ||
        normalized.includes('bacon') || normalized.includes('dinde')) {
      // Viandes: typiquement vendues par 500g-1kg
      standardSize = { size: 1000, unit: 'g' };
    } else if (normalized.includes('poisson') || normalized.includes('saumon') ||
               normalized.includes('crevette') || normalized.includes('morue')) {
      // Poisson: typiquement vendu par 400-500g
      standardSize = { size: 500, unit: 'g' };
    } else if (normalized.includes('fromage')) {
      // Fromage: typiquement vendu par 400g
      standardSize = { size: 400, unit: 'g' };
    } else if (unitLower === 'g' || unitLower === 'kg') {
      // Fallback pour poids: assumer 500g
      standardSize = { size: 500, unit: 'g' };
    } else if (unitLower === 'ml' || unitLower === 'l') {
      // Fallback pour volume: assumer 500ml
      standardSize = { size: 500, unit: 'ml' };
    }
  }
  
  if (!standardSize) {
    // Si on ne connaît toujours pas la taille, retourner le prix du produit entier
    return productPrice;
  }
  
  // Convertir la quantité de la recette en ml ou g
  let recipeQuantityInStandardUnit: number | null = null;
  
  if (standardSize.unit === 'ml') {
    // Le produit est mesuré en ml
    if (UNIT_TO_ML[unitLower] !== undefined) {
      recipeQuantityInStandardUnit = quantity * UNIT_TO_ML[unitLower];
    } else if (UNIT_TO_G[unitLower] !== undefined) {
      // Conversion approximative g → ml (densité ~1)
      recipeQuantityInStandardUnit = quantity * UNIT_TO_G[unitLower];
    }
  } else {
    // Le produit est mesuré en g
    if (UNIT_TO_G[unitLower] !== undefined) {
      recipeQuantityInStandardUnit = quantity * UNIT_TO_G[unitLower];
    } else if (UNIT_TO_ML[unitLower] !== undefined) {
      // Conversion approximative ml → g (densité ~1)
      recipeQuantityInStandardUnit = quantity * UNIT_TO_ML[unitLower];
    }
  }
  
  if (recipeQuantityInStandardUnit === null) {
    // Unité non reconnue, retourner le prix du produit entier
    return productPrice;
  }
  
  // Calculer le prix proportionnel
  const proportion = recipeQuantityInStandardUnit / standardSize.size;
  const proportionalPrice = productPrice * proportion;
  
  // Arrondir à 2 décimales, minimum 0.01$
  return Math.max(0.01, Math.round(proportionalPrice * 100) / 100);
}

function normalizeQuantityToPackages(quantity: number, unit: string): number {
  const u = unit.toLowerCase().trim();
  
  if (u === 'g' || u === 'gramme' || u === 'grammes') {
    return Math.max(1, Math.ceil(quantity / 500));
  }
  if (u === 'kg' || u === 'kilogramme' || u === 'kilogrammes') {
    return Math.max(1, Math.ceil(quantity));
  }
  if (u === 'ml' || u === 'millilitre' || u === 'millilitres') {
    return Math.max(1, Math.ceil(quantity / 500));
  }
  if (u === 'l' || u === 'litre' || u === 'litres') {
    return Math.max(1, Math.ceil(quantity));
  }
  if (u === 'cl' || u === 'centilitre' || u === 'centilitres') {
    return Math.max(1, Math.ceil(quantity / 50));
  }
  if (u === 'c. à soupe' || u === 'c.s.' || u === 'tbsp' || u === 'cuillère à soupe') {
    return 1;
  }
  if (u === 'c. à thé' || u === 'c.t.' || u === 'tsp' || u === 'cuillère à thé') {
    return 1;
  }
  if (u === 'tasse' || u === 'tasses' || u === 'cup' || u === 'cups') {
    return 1;
  }
  
  if (u === '' || u === 'unité' || u === 'unités' || u === 'pièce' || u === 'pièces') {
    return 1;
  }
  
  return 1;
}

// Calculer le coût à partir d'un prix unitaire NORMALISÉ ($/kg ou $/L, pas $/g ou $/ml)
// NOTE: Le unit_price de unified_prices est DÉJÀ normalisé en $/kg ou $/L
function calculateCostFromUnitPrice(
  quantity: number,
  unit: string,
  unitPrice: number, // prix en $/kg ou $/L (déjà normalisé)
  ingredientName: string,
  priceUnit: string // 'kg' ou 'l' pour savoir comment normaliser la quantité
): number {
  const unitLower = unit.toLowerCase().trim();
  const priceUnitLower = priceUnit.toLowerCase();
  
  // Si le prix est déjà en "unité" (pas en kg/L), retourner prix × quantité
  if (priceUnitLower === 'unité' || priceUnitLower === '') {
    return Math.max(0.01, Math.round(unitPrice * quantity * 100) / 100);
  }
  
  // Convertir la quantité de la recette en kg ou L (pour correspondre au prix normalisé)
  let quantityNormalized: number | null = null;
  
  if (priceUnitLower === 'kg') {
    // Convertir vers kg
    if (UNIT_TO_G[unitLower] !== undefined) {
      quantityNormalized = (quantity * UNIT_TO_G[unitLower]) / 1000; // g → kg
    } else if (unitLower === 'g') {
      quantityNormalized = quantity / 1000;
    } else if (unitLower === 'kg') {
      quantityNormalized = quantity;
    } else if (UNIT_TO_ML[unitLower] !== undefined) {
      // Approximation ml → g → kg (densité ≈ 1)
      quantityNormalized = (quantity * UNIT_TO_ML[unitLower]) / 1000;
    } else if (unitLower === '' || unitLower === 'unité' || unitLower === 'unités' || 
               unitLower === 'pièce' || unitLower === 'pièces') {
      // Recette demande "X unité" mais prix est en $/kg
      // Utiliser le poids par unité si disponible
      const unitWeight = getUnitWeightInGrams(ingredientName);
      if (unitWeight !== null) {
        quantityNormalized = (quantity * unitWeight) / 1000; // unités → g → kg
        console.log(`[PriceCalc] ${ingredientName}: ${quantity} unités × ${unitWeight}g = ${quantityNormalized * 1000}g → ${(unitPrice * quantityNormalized).toFixed(2)}$`);
      }
    }
  } else if (priceUnitLower === 'l') {
    // Convertir vers L
    if (UNIT_TO_ML[unitLower] !== undefined) {
      quantityNormalized = (quantity * UNIT_TO_ML[unitLower]) / 1000; // ml → L
    } else if (unitLower === 'ml') {
      quantityNormalized = quantity / 1000;
    } else if (unitLower === 'l') {
      quantityNormalized = quantity;
    } else if (UNIT_TO_G[unitLower] !== undefined) {
      // Approximation g → ml → L (densité ≈ 1)
      quantityNormalized = (quantity * UNIT_TO_G[unitLower]) / 1000;
    }
  }
  
  // Si unité non reconnue et pas de conversion possible
  if (quantityNormalized === null) {
    // Pour les ingrédients vendus à l'unité sans poids connu, assumer 100g par unité
    if (isUnitBasedIngredient(ingredientName) && priceUnitLower === 'kg') {
      const defaultUnitWeight = 100; // grammes par défaut
      quantityNormalized = (quantity * defaultUnitWeight) / 1000;
      console.log(`[PriceCalc] ${ingredientName}: ${quantity} unités × ${defaultUnitWeight}g (défaut) = ${quantityNormalized * 1000}g`);
    } else {
      // Fallback: retourner prix × quantité (peut être incorrect mais évite les 0)
      return Math.max(0.01, Math.round(unitPrice * quantity * 100) / 100);
    }
  }
  
  // Calculer le coût: prix_unitaire ($/kg ou $/L) × quantité normalisée (en kg ou L)
  const cost = unitPrice * quantityNormalized;
  
  return Math.max(0.01, Math.round(cost * 100) / 100);
}

// Nouvelle fonction pour trouver le prix unitaire dans unified_prices
// NOTE: Le unit_price de unified_prices est DÉJÀ normalisé en $/kg ou $/L
function findUnifiedPrice(
  ingredientName: string,
  storeData: CachedStoreData
): { unitPrice: number; normalizedUnit: string; productPrice: number; quantity: number; unit: string } | null {
  const searchTerms = normalizeText(ingredientName).split(/\s+/).filter(t => t.length > 2);
  const fullNameNorm = normalizeText(ingredientName);
  
  let bestMatch: UnifiedPriceData | null = null;
  let bestScore = 0;
  
  for (const unified of storeData.unified) {
    if (!unified.genericProduct) continue; // Skip if no product name
    
    const productNorm = normalizeText(unified.genericProduct);
    
    // Correspondance exacte = score élevé
    if (productNorm === fullNameNorm) {
      bestMatch = unified;
      break;
    }
    
    // Correspondance partielle
    const matches = productNorm.includes(fullNameNorm) || fullNameNorm.includes(productNorm) ||
      searchTerms.some(term => productNorm.includes(term));
    
    if (matches) {
      // Score basé sur la longueur de correspondance
      const score = fullNameNorm.length / productNorm.length;
      if (!bestMatch || score > bestScore) {
        bestMatch = unified;
        bestScore = score;
      }
    }
  }
  
  if (!bestMatch) return null;
  
  const productPrice = bestMatch.salePrice ?? bestMatch.regularPrice ?? 0;
  if (productPrice === 0) return null;
  
  const unit = (bestMatch.unit || '').toLowerCase();
  const quantity = bestMatch.quantity || 1;
  
  // Le unit_price de la DB est DÉJÀ normalisé en $/kg ou $/L
  // Déterminer l'unité normalisée
  let normalizedUnit: string;
  let normalizedUnitPrice: number;
  
  if (bestMatch.unitPrice !== null) {
    // unitPrice de la DB est DÉJÀ en $/kg ou $/L
    normalizedUnitPrice = bestMatch.unitPrice;
    if (unit === 'g' || unit === 'kg') {
      normalizedUnit = 'kg';
    } else if (unit === 'ml' || unit === 'l') {
      normalizedUnit = 'l';
    } else {
      normalizedUnit = unit || 'unité';
    }
  } else if (quantity > 0) {
    // Calculer et normaliser le prix unitaire
    if (unit === 'g') {
      normalizedUnitPrice = (productPrice / quantity) * 1000; // $/g → $/kg
      normalizedUnit = 'kg';
    } else if (unit === 'ml') {
      normalizedUnitPrice = (productPrice / quantity) * 1000; // $/ml → $/L
      normalizedUnit = 'l';
    } else if (unit === 'kg') {
      normalizedUnitPrice = productPrice / quantity;
      normalizedUnit = 'kg';
    } else if (unit === 'l') {
      normalizedUnitPrice = productPrice / quantity;
      normalizedUnit = 'l';
    } else {
      normalizedUnitPrice = productPrice / quantity;
      normalizedUnit = unit || 'unité';
    }
  } else {
    return null;
  }
  
  return {
    unitPrice: normalizedUnitPrice,
    normalizedUnit,
    productPrice,
    quantity: bestMatch.quantity,
    unit: bestMatch.unit,
  };
}

// Interface étendue pour inclure l'unité normalisée
interface IngredientPricingResultWithUnit extends IngredientPricingResult {
  normalizedUnit?: string;
}

// Mots clés principaux pour le matching (élargis pour mieux capturer les ingrédients communs)
const INGREDIENT_KEYWORDS: Record<string, string[]> = {
  'poulet': ['poulet', 'volaille', 'poitrine poulet', 'cuisse poulet', 'aile poulet'],
  'boeuf': ['boeuf', 'bifteck', 'steak', 'viande hachee', 'haché'],
  'porc': ['porc', 'cotelette', 'longe', 'filet porc', 'bacon', 'jambon'],
  'poisson': ['poisson', 'saumon', 'tilapia', 'truite', 'morue', 'sole', 'thon'],
  'oeuf': ['oeuf', 'oeufs'],
  'lait': ['lait', 'lactose'],
  'fromage': ['fromage', 'cheddar', 'mozzarella', 'parmesan', 'brie', 'feta'],
  'yogourt': ['yogourt', 'yaourt', 'grec', 'iogo'],
  'pain': ['pain', 'baguette', 'croute', 'tranche'],
  'pates': ['pate', 'pates', 'spaghetti', 'macaroni', 'penne', 'fusilli', 'catelli'],
  'riz': ['riz', 'basmati', 'jasmin'],
  'tomate': ['tomate', 'tomates'],
  'oignon': ['oignon', 'oignons', 'echalote'],
  'ail': ['ail', 'gousse'],
  'carotte': ['carotte', 'carottes'],
  'pomme de terre': ['pomme terre', 'patate', 'patates', 'pommes terre'],
  'beurre': ['beurre', 'margarine'],
  'huile': ['huile', 'olive', 'canola', 'vegetale'],
  'sucre': ['sucre', 'cassonade'],
  'farine': ['farine', 'ble'],
  'legumes': ['legume', 'legumes', 'brocoli', 'epinard', 'courgette', 'poivron'],
  'fruits': ['pomme', 'banane', 'orange', 'fraise', 'bleuet', 'framboise'],
};

function getRelatedKeywords(ingredientName: string): string[] {
  const normalized = normalizeText(ingredientName);
  const keywords: string[] = [];
  
  for (const [key, values] of Object.entries(INGREDIENT_KEYWORDS)) {
    const keyNorm = normalizeText(key);
    // Si l'ingrédient contient ou est contenu par le mot clé principal
    if (normalized.includes(keyNorm) || keyNorm.includes(normalized)) {
      keywords.push(...values);
    }
    // Ou si un des mots clés de la liste correspond
    if (values.some(v => normalized.includes(normalizeText(v)))) {
      keywords.push(...values);
    }
  }
  
  return Array.from(new Set(keywords)); // Retirer les doublons
}

// Liste de mots clés à exclure (produits non-alimentaires)
const EXCLUDED_PRODUCT_KEYWORDS = [
  'pampers', 'huggies', 'couche', 'couches', 'diaper', 'diapers',
  'tablet', 'tablette', 'samsung', 'apple', 'iphone', 'ipad', 'galaxy',
  'television', 'televiseur', 'tele', 'ecran', 'monitor',
  'matelas', 'meuble', 'meubles', 'furniture',
  'velo', 'vélo', 'bicycle', 'exercice', 'fitness',
  'pelle', 'neige', 'outils', 'tools',
  'shampoo', 'shampooing', 'savon', 'soap', 'detergent', 'nettoyant',
  'papier toilette', 'toilet paper', 'mouchoir', 'tissue',
  'vetement', 'vêtement', 'clothing', 'shirt', 'pantalon',
  'matcha', 'supplement', 'vitamine', 'vitamin',
  'fonctionnel', 'functional', 'adaptogene', 'adaptogen',
];

// Vérifier si un mot correspond exactement (pas comme sous-chaîne)
function matchesWholeWord(text: string, word: string): boolean {
  // Créer une regex pour correspondance de mot entier
  const regex = new RegExp(`(^|\\s|[^a-z])${word}($|\\s|[^a-z])`, 'i');
  return regex.test(text);
}

function scorePromoMatch(ingredientName: string, promoName: string): number {
  const ingredientNorm = normalizeText(ingredientName);
  const promoNorm = normalizeText(promoName);
  
  // EXCLUSION: Rejeter les produits non-alimentaires
  for (const excluded of EXCLUDED_PRODUCT_KEYWORDS) {
    if (promoNorm.includes(excluded)) {
      return 0; // Exclure ce produit
    }
  }
  
  // EXCLUSION: Rejeter les prix > $50 pour les ingrédients courants
  // (appliqué ailleurs, mais on peut ajouter une logique ici si nécessaire)
  
  // Score de correspondance exacte du MOT (pas substring)
  // Ex: "ail" doit correspondre à "ail" mais pas à "taille"
  const ingredientWords = ingredientNorm.split(/\s+/).filter(w => w.length >= 2);
  const promoWords = promoNorm.split(/\s+/).filter(w => w.length >= 2);
  
  // Correspondance exacte du nom complet comme mot
  if (promoWords.some(pw => pw === ingredientNorm) || matchesWholeWord(promoNorm, ingredientNorm)) {
    return 1.0;
  }
  
  // Correspondance partielle basée sur des mots COMPLETS (pas des sous-chaînes)
  let exactWordMatches = 0;
  let partialMatches = 0;
  
  for (const ingWord of ingredientWords) {
    // Chercher correspondance exacte de mot
    if (promoWords.some(pw => pw === ingWord)) {
      exactWordMatches++;
    }
    // Correspondance partielle seulement si le mot de l'ingrédient est au début ou à la fin du mot promo
    else if (promoWords.some(pw => pw.startsWith(ingWord) || pw.endsWith(ingWord))) {
      // Seulement si le mot est assez long pour éviter "ail" dans "taille"
      if (ingWord.length >= 4) {
        partialMatches += 0.5;
      }
    }
  }
  
  if (ingredientWords.length === 0) return 0;
  
  // Score basé sur les correspondances exactes (priorité) + partielles (bonus réduit)
  const exactScore = exactWordMatches / ingredientWords.length;
  const partialScore = partialMatches / ingredientWords.length * 0.3;
  const baseScore = exactScore + partialScore;
  
  // Bonus pour les mots clés associés (seulement correspondance exacte)
  const relatedKeywords = getRelatedKeywords(ingredientName);
  if (relatedKeywords.length > 0) {
    for (const kw of relatedKeywords) {
      if (promoWords.some(pw => pw === kw) || matchesWholeWord(promoNorm, kw)) {
        return Math.max(baseScore, 0.5);
      }
    }
  }
  
  return baseScore;
}

// Plafonds de sécurité - valeurs réalistes pour épicerie québécoise
// Ces plafonds captent les erreurs de matching (ex: Pampers à $80) sans affecter les vrais ingrédients
const GLOBAL_MAX_INGREDIENT_PRICE = 50; // Maximum $50 pour un prix de base (viandes spécialisées, fruits de mer)
const GLOBAL_MAX_INGREDIENT_COST = 60; // Maximum $60 pour coût calculé avec quantité (ex: grande quantité de viande)

// Plafonds spécifiques par type d'ingrédient (prix maximum raisonnable au Québec)
// Ces plafonds évitent les faux positifs avec des produits non-alimentaires
const INGREDIENT_PRICE_CAPS: Record<string, number> = {
  // Condiments et sauces (très petit format utilisé)
  'eau': 3, 'water': 3,
  'sel': 4, 'salt': 4,
  'poivre': 8, 'pepper': 8,
  'sucre': 6, 'sugar': 6,
  'miel': 12, 'honey': 12, 'sirop': 12, 'syrup': 12,
  'sauce soya': 6, 'soy sauce': 6, 'sauce soja': 6,
  'sauce poisson': 6, 'fish sauce': 6,
  'vinaigre': 6, 'vinegar': 6,
  'huile': 12, 'oil': 12,
  'moutarde': 5, 'mustard': 5,
  'ketchup': 5,
  'mayonnaise': 6, 'mayo': 6,
  'sambal': 6, 'sriracha': 6,
  // Herbes et épices
  'ail': 5, 'garlic': 5,
  'oignon': 4, 'onion': 4,
  'echalote': 4, 'shallot': 4,
  'oignons verts': 4, 'green onion': 4,
  'gingembre': 5, 'ginger': 5,
  'coriandre': 4, 'cilantro': 4,
  'persil': 4, 'parsley': 4,
  'basilic': 4, 'basil': 4,
  'thym': 4, 'thyme': 4,
  'romarin': 4, 'rosemary': 4,
  'menthe': 4, 'mint': 4,
  'laurier': 4, 'bay': 4,
  'piment': 4, 'chili': 4, 'jalapeno': 4,
  'cumin': 5, 'paprika': 5, 'curcuma': 5,
  // Légumes de base
  'carotte': 5, 'carrot': 5,
  'celeri': 4, 'celery': 4,
  'pomme de terre': 6, 'potato': 6, 'patate': 6,
  'tomate': 6, 'tomato': 6,
  'concombre': 4, 'cucumber': 4,
  'poivron': 5, 'bell pepper': 5,
  'laitue': 4, 'lettuce': 4,
  'epinard': 5, 'spinach': 5,
  'brocoli': 5, 'broccoli': 5,
  'chou': 4, 'cabbage': 4,
  'courgette': 4, 'zucchini': 4,
  'champignon': 6, 'mushroom': 6,
  // Fruits de base
  'citron': 4, 'lemon': 4,
  'lime': 4,
  'orange': 5,
  'pomme': 5, 'apple': 5,
  'banane': 4, 'banana': 4,
  // Produits laitiers courants
  'beurre': 8, 'butter': 8,
  'creme': 6, 'cream': 6,
  'lait': 6, 'milk': 6,
  'yogourt': 6, 'yogurt': 6,
  'ricotta': 8,
  'feta': 10,
  'parmesan': 12,
  // Bases de cuisine
  'bouillon': 5, 'broth': 5, 'stock': 5,
  'pate tomate': 4, 'tomato paste': 4,
  'concentre': 5,
  'farine': 6, 'flour': 6,
  'oeuf': 8, 'egg': 8,
  'tapioca': 6, 'fecule': 5, 'starch': 5,
  'levure': 5, 'yeast': 5,
  'gelatine': 5,
  // Pâtes et grains
  'pates': 6, 'pasta': 6, 'spaghetti': 6, 'macaroni': 6,
  'riz': 8, 'rice': 8,
  'quinoa': 10,
  'couscous': 6,
  // Noix et graines (peuvent être chers mais plafonnés)
  'noix': 15, 'nut': 15, 'amande': 15, 'almond': 15,
  'arachide': 8, 'peanut': 8,
  'sesame': 8,
};

// Obtenir le plafond de prix pour un ingrédient spécifique
function getIngredientPriceCap(ingredientName: string): number {
  const normalized = normalizeText(ingredientName);
  
  // Chercher correspondance exacte ou partielle
  for (const [key, cap] of Object.entries(INGREDIENT_PRICE_CAPS)) {
    if (normalized.includes(normalizeText(key)) || normalizeText(key).includes(normalized)) {
      return cap;
    }
  }
  
  // Retourner le plafond global par défaut
  return GLOBAL_MAX_INGREDIENT_PRICE;
}

function findBestPrice(
  ingredientName: string,
  ingredientCategory: string | null,
  storeData: CachedStoreData
): IngredientPricingResultWithUnit {
  // Obtenir le plafond de prix spécifique pour cet ingrédient
  const ingredientPriceCap = getIngredientPriceCap(ingredientName);
  
  // PRIORITÉ 1: unified_prices avec prix unitaire normalisé ($/kg ou $/L)
  const unifiedMatch = findUnifiedPrice(ingredientName, storeData);
  if (unifiedMatch && unifiedMatch.unitPrice > 0) {
    // PLAFOND: Utiliser le plafond spécifique à l'ingrédient
    const cappedPrice = Math.min(unifiedMatch.unitPrice, ingredientPriceCap);
    return { 
      ingredientName, 
      price: cappedPrice, 
      source: 'unified',
      normalizedUnit: unifiedMatch.normalizedUnit 
    };
  }
  
  // PRIORITÉ 2: promotions Flipp - avec scoring amélioré et plafond spécifique
  let bestPromo: { price: number; score: number; productName: string } | null = null;
  for (const promo of storeData.promos) {
    // FILTRE: Ignorer les promotions avec prix > plafond SPÉCIFIQUE à l'ingrédient
    if (promo.promoPrice > ingredientPriceCap) {
      continue;
    }
    
    const score = scorePromoMatch(ingredientName, promo.productName);
    
    // Seuil minimum de 0.5 pour considérer un match
    if (score >= 0.5) {
      // Préférer le score le plus élevé, puis le prix le plus bas
      if (!bestPromo || score > bestPromo.score || 
          (score === bestPromo.score && promo.promoPrice < bestPromo.price)) {
        bestPromo = { price: promo.promoPrice, score, productName: promo.productName };
      }
    }
  }
  
  if (bestPromo) {
    console.log(`[PriceMatch] "${ingredientName}" → "${bestPromo.productName}" @ $${bestPromo.price} (score: ${bestPromo.score.toFixed(2)}, cap: $${ingredientPriceCap})`);
    return { ingredientName, price: bestPromo.price, source: 'promo' };
  }
  
  // PRIORITÉ 3: prix de référence avec plafond spécifique
  let bestRef: { price: number; score: number } | null = null;
  for (const ref of storeData.refs) {
    // FILTRE: Ignorer les prix de référence > plafond SPÉCIFIQUE
    if (ref.price > ingredientPriceCap) {
      continue;
    }
    
    const score = scorePromoMatch(ingredientName, ref.productName);
    
    // Seuil minimum de 0.5 pour considérer un match
    if (score >= 0.5) {
      if (!bestRef || score > bestRef.score ||
          (score === bestRef.score && ref.price < bestRef.price)) {
        bestRef = { price: ref.price, score };
      }
    }
  }
  
  if (bestRef) {
    return { ingredientName, price: bestRef.price, source: 'reference' };
  }
  
  // PRIORITÉ 4: estimation par catégorie (plafonnée aussi)
  let estimate = ingredientCategory ? categoryEstimates[ingredientCategory] || 3.99 : 3.99;
  estimate = Math.min(estimate, ingredientPriceCap);
  return { ingredientName, price: estimate, source: 'estimate' };
}

export async function runRecipePriceCalculation(): Promise<{
  success: boolean;
  recipesProcessed: number;
  storesProcessed: number;
  errors: string[];
}> {
  // Auto-reset if stuck for too long
  if (isCalculating && calculationStartTime) {
    const elapsed = Date.now() - calculationStartTime;
    if (elapsed > MAX_CALCULATION_TIME_MS) {
      console.log(`[RecipePriceCalculation] Auto-resetting stuck calculation flag (was running for ${Math.round(elapsed / 1000)}s)`);
      isCalculating = false;
      calculationStartTime = null;
    }
  }
  
  if (isCalculating) {
    return {
      success: false,
      recipesProcessed: 0,
      storesProcessed: 0,
      errors: ['Calculation already in progress'],
    };
  }
  
  isCalculating = true;
  calculationStartTime = Date.now();
  const errors: string[] = [];
  let recipesProcessed = 0;
  let storesProcessed = 0;
  
  console.log('[RecipePriceCalculation] Starting weekly recipe price calculation...');
  
  // Load ingredient equivalences from database (for unit conversions)
  await loadIngredientEquivalences();
  
  try {
    const today = new Date().toISOString().split('T')[0];
    const weekOf = getWeekStart();
    
    // load recipes data from database
    // charger les données des recettes depuis la base de données
    const allRecipes = await db.select().from(recipes);
    const rawStores = await db.select().from(stores);
    const allIngredients = await db.select().from(ingredients);
    const allRecipeIngredients = await db.select().from(recipeIngredients);

    /**
     * FR: Filtrage préventif des magasins. On retire Adonis et Provigo avant le calcul.
     * EN: Preventive store filtering. Adonis and Provigo are removed before calculation starts.
     */
    const allStores = rawStores.filter(store => 
      store.id !== STORE_IDS.ADONIS && store.id !== STORE_IDS.PROVIGO
    );
    
    const ingredientMap = new Map(allIngredients.map(i => [i.id, i]));
    const recipeIngredientsMap = new Map<string, typeof allRecipeIngredients>();
    for (const ri of allRecipeIngredients) {
      const list = recipeIngredientsMap.get(ri.recipeId) || [];
      list.push(ri);
      recipeIngredientsMap.set(ri.recipeId, list);
    }
    
    console.log(`[RecipePriceCalculation] Loaded ${allRecipes.length} recipes, ${allStores.length} stores (filtered), ${allIngredients.length} ingredients`);
    
    for (const store of allStores) {
      console.log(`[RecipePriceCalculation] Processing store: ${store.name}`);
      
      const storeUnified = await db
        .select({
          genericProduct: unifiedPrices.genericName,
          regularPrice: unifiedPrices.regularPrice,
          salePrice: unifiedPrices.salePrice,
          unitPrice: unifiedPrices.unitPrice,
          quantity: unifiedPrices.quantity,
          unit: unifiedPrices.unit,
        })
        .from(unifiedPrices)
        .where(eq(unifiedPrices.storeId, store.id));
      
      const storePromos = await db
        .select({ productName: flyerPromotions.productName, promoPrice: flyerPromotions.promoPrice })
        .from(flyerPromotions)
        .where(and(
          eq(flyerPromotions.storeId, store.id),
          gte(flyerPromotions.validUntil, today)
        ));
      
      const storeRefs = await db
        .select({ productName: referencePrices.productName, price: referencePrices.price })
        .from(referencePrices)
        .where(eq(referencePrices.storeId, store.id));
      
      const storeData: CachedStoreData = {
        unified: storeUnified,
        promos: storePromos,
        refs: storeRefs,
      };
      
      console.log(`[RecipePriceCalculation] Store ${store.name}: ${storeUnified.length} unified, ${storePromos.length} promos, ${storeRefs.length} refs`);
      
      for (const recipe of allRecipes) {
        try {
          const recipeIngs = recipeIngredientsMap.get(recipe.id) || [];
          const aggregatedIngs = new Map<string, { ingredientId: string; quantity: number; unit: string }>();
          
          for (const ri of recipeIngs) {
            const existing = aggregatedIngs.get(ri.ingredientId);
            if (existing) {
              existing.quantity += (ri.quantity || 1);
            } else {
              aggregatedIngs.set(ri.ingredientId, { 
                ingredientId: ri.ingredientId, 
                quantity: ri.quantity || 1, 
                unit: ri.unit || 'unité' 
              });
            }
          }
          
          let totalCost = 0;
          let missingCount = 0;
          const breakdown: IngredientBreakdownItem[] = [];
          
          for (const ri of Array.from(aggregatedIngs.values())) {
            const ingredient = ingredientMap.get(ri.ingredientId);
            if (!ingredient) {
              missingCount++;
              continue;
            }
            
            const pricing = findBestPrice(ingredient.name, ingredient.category, storeData);
            
            /**
             * FR: Objectif 1 & 2 - Si le prix est une estimation, on marque l'ingrédient comme manquant.
             * EN: Objective 1 & 2 - If price is an estimate, we mark the ingredient as missing.
             */
            if (pricing.source === 'estimate') {
              missingCount++;
            }
            
            const quantity = ri.quantity || 1;
            const unit = ri.unit || 'unité';
            let costForQuantity: number;
            
            /**
             * FR: Objectif 4 - Calcul précis via prix unitaire ou proportionnel.
             * EN: Objective 4 - Precise calculation via unit or proportional price.
             */
            if (pricing.source === 'unified' && pricing.normalizedUnit) {
              costForQuantity = calculateCostFromUnitPrice(
                quantity, unit, pricing.price, ingredient.name, pricing.normalizedUnit
              );
            } else {
              costForQuantity = calculateProportionalCost(
                quantity, unit, pricing.price, ingredient.name
              );
            }
            
            if (costForQuantity > GLOBAL_MAX_INGREDIENT_COST) {
              costForQuantity = GLOBAL_MAX_INGREDIENT_COST;
            }
            
            totalCost += costForQuantity;
            
            let priceUnit = 'unité';
            if (pricing.source === 'unified' && pricing.normalizedUnit) {
              priceUnit = pricing.normalizedUnit;
            } else {
              const unitLower = unit.toLowerCase();
              if (['g', 'kg', 'lb', 'oz'].some(u => unitLower.includes(u))) priceUnit = 'kg';
              else if (['ml', 'l', 'cl', 'tasse', 'cup'].some(u => unitLower.includes(u))) priceUnit = 'l';
            }
            
            breakdown.push({
              ingredientId: ri.ingredientId,
              ingredientName: ingredient.name,
              quantity,
              unit,
              unitPrice: pricing.price,
              priceUnit,
              calculatedCost: Math.round(costForQuantity * 100) / 100,
              source: pricing.source,
            });
          }
          
          totalCost = Math.round(totalCost * 100) / 100;
          const MAX_RECIPE_TOTAL = 200;
          if (totalCost > MAX_RECIPE_TOTAL) totalCost = MAX_RECIPE_TOTAL;
          
          /**
           * FR: La recette est complète UNIQUEMENT si missingCount est 0.
           * EN: Recipe is marked complete ONLY if missingCount is 0.
           */
          const isComplete = missingCount === 0 && totalCost > 0;
          
          const existingPrice = await db
            .select()
            .from(recipeStorePrices)
            .where(and(
              eq(recipeStorePrices.recipeId, recipe.id),
              eq(recipeStorePrices.storeId, store.id),
              eq(recipeStorePrices.weekOf, weekOf)
            ))
            .limit(1);
          
          if (existingPrice.length > 0) {
            await db
              .update(recipeStorePrices)
              .set({
                totalCost,
                missingIngredientsCount: missingCount,
                isComplete,
                ingredientBreakdown: JSON.stringify(breakdown),
                calculatedAt: new Date().toISOString(),
              })
              .where(eq(recipeStorePrices.id, existingPrice[0].id));
          } else {
            await db.insert(recipeStorePrices).values({
              recipeId: recipe.id,
              storeId: store.id,
              weekOf,
              totalCost,
              missingIngredientsCount: missingCount,
              isComplete,
              ingredientBreakdown: JSON.stringify(breakdown),
              calculatedAt: new Date().toISOString(),
            });
          }
          storesProcessed++;
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          errors.push(`Recipe ${recipe.id} / Store ${store.id}: ${message}`);
        }
      }
      recipesProcessed = allRecipes.length;
    }
    
    /**
     * FR: Mise à jour finale - Seuls les prix des magasins où la recette est complète sont comparés.
     * EN: Final update - Only prices from stores where the recipe is complete are compared.
     */
    console.log('[RecipePriceCalculation] Updating recipes estimated prices...');
    // VALIDATION FINALE : Seules les recettes complètes mettent à jour le prix public
    await db.execute(sql`
      UPDATE recipes r
      SET estimated_price = sub.min_price
      FROM (
        SELECT recipe_id, MIN(total_cost) as min_price
        FROM recipe_store_prices
        WHERE total_cost > 0 AND is_complete = true
        GROUP BY recipe_id
      ) sub
      WHERE r.id = sub.recipe_id
    `);
    
    return {
      success: true,
      recipesProcessed,
      storesProcessed,
      errors,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[RecipePriceCalculation] Fatal error:', message);
    
    return {
      success: false,
      recipesProcessed,
      storesProcessed,
      errors: [...errors, message],
    };
  } finally {
    isCalculating = false;
    calculationStartTime = null;
  }
}

// Force reset the calculation lock (for admin use when stuck)
export function forceResetCalculationLock(): boolean {
  const wasLocked = isCalculating;
  isCalculating = false;
  calculationStartTime = null;
  console.log(`[RecipePriceCalculation] Force reset calculation lock (was locked: ${wasLocked})`);
  return wasLocked;
}

export function scheduleWeeklyRecipePriceCalculation(): void {
  // DISABLED: Recipe price calculation is now done manually via Excel export/import workflow
  // The weekly flyer sync no longer triggers automatic price calculation
  console.log('[RecipePriceCalculation] Weekly auto-calculation disabled - use manual Excel workflow');
}

export function stopScheduledCalculation(): void {
  if (calculationTask) {
    calculationTask.stop();
    calculationTask = null;
  }
}