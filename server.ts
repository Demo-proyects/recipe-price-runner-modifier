import express from 'express';
import cors from 'cors';
import { stores, recipes, prices, STORE_IDS } from './mock-data';

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// --- FONCTION DE CONVERSION (LE CŒUR DU CORRECTIF) ---
// Cette fonction transforme toutes les unités (lb, kg, ml) en grammes
// pour permettre une comparaison de prix juste.
function getStandardQuantityInGrams(quantity: number, unit: string): number {
    const u = unit.toLowerCase().trim();
    
    // Conversion de masse
    if (u === 'kg') return quantity * 1000;
    if (u === 'lb' || u === 'lbs' || u === 'livre') return quantity * 454;
    
    // Simplification pour les liquides (densité eau)
    if (u === 'l') return quantity * 1000;
    if (u === 'ml') return quantity;
    
    // Par défaut (g, ou unité indivisible)
    return quantity;
}

// --- LOGIQUE DE CALCUL ---
app.get('/calculate', (req, res) => {
    console.log("🔄 Démarrage du calcul...");

    // 1. Définir les magasins autorisés (Exclusion d'Adonis et Provigo)
    // Supposons que les IDs valides sont Metro(1), IGA(2), Maxi(3), Super C(4)
    // On exclut explicitement tout ce qui n'est pas dans cette liste.
    const allowedStoreIds = [1, 2, 3, 4]; 

    const results = recipes.map(recipe => {
        let recipeTotalPrice = 0;
        let isRecipeValid = true;

        const calculatedIngredients = recipe.ingredients.map(ingredient => {
            
            // 2. Trouver les prix pour cet ingrédient UNIQUEMENT dans les magasins autorisés
            const availablePrices = prices.filter(p => 
                p.ingredientId === ingredient.id && 
                allowedStoreIds.includes(p.storeId)
            );

            // Cas d'erreur : Ingrédient introuvable (ex: Safran pour la Paella)
            if (availablePrices.length === 0) {
                isRecipeValid = false;
                return {
                    ...ingredient,
                    error: "Non disponible dans les épiceries sélectionnées",
                    bestDeal: null
                };
            }

            // 3. Trouver le meilleur prix (Algorithme de normalisation)
            let bestPrice = Infinity;
            let bestDeal = null;

            availablePrices.forEach(p => {
                // A. Convertir la quantité du magasin en grammes (ex: 1 lb -> 454g)
                const storeQtyInGrams = getStandardQuantityInGrams(p.quantity, p.unit);
                
                // B. Calculer le prix par gramme
                const pricePerGram = p.price / storeQtyInGrams;

                // C. Convertir la quantité requise par la recette en grammes (ex: 1.2 kg -> 1200g)
                const recipeNeedInGrams = getStandardQuantityInGrams(ingredient.quantity, ingredient.unit);

                // D. Coût final pour la recette
                const costForRecipe = pricePerGram * recipeNeedInGrams;

                // Comparaison : est-ce moins cher que le précédent ?
                if (costForRecipe < bestPrice) {
                    bestPrice = costForRecipe;
                    bestDeal = {
                        storeId: p.storeId,
                        price: p.price, // Prix affiché en magasin
                        unit: p.unit,   // Unité magasin
                        costCalculated: parseFloat(costForRecipe.toFixed(2)) // Coût réel pour le plat
                    };
                }
            });

            recipeTotalPrice += bestPrice;

            return {
                ...ingredient,
                bestDeal: bestDeal
            };
        });

        return {
            recipeName: recipe.name,
            ingredients: calculatedIngredients,
            totalPrice: isRecipeValid ? parseFloat(recipeTotalPrice.toFixed(2)) : 0
        };
    });

    console.log("✅ Calcul terminé. Envoi des résultats.");
    res.json(results);
});

app.listen(PORT, () => {
    console.log(`✅ SERVEUR DE TEST ACTIF sur http://localhost:${PORT}`);
    console.log(`   -> Prêt à valider les calculs.`);
});
