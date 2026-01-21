export const STORE_IDS = {
    IGA: 'iga',
    METRO: 'metro',
    SUPER_C: 'super-c',
    MAXI: 'maxi',
    PROVIGO: 'provigo',
    ADONIS: 'adonis',
};

// 1. Les Magasins
export const stores = [
    { id: 'iga', name: 'IGA' },
    { id: 'metro', name: 'Metro' },
    { id: 'super-c', name: 'Super C' },
    { id: 'maxi', name: 'Maxi' },
    { id: 'provigo', name: 'Provigo' }, // À EXCLURE
    { id: 'adonis', name: 'Adonis' }    // À EXCLURE
];

// 2. Les Ingrédients
export const ingredients = [
    { id: 'ing_boeuf', name: 'Boeuf haché' },
    { id: 'ing_patates', name: 'Pommes de terre' },
    { id: 'ing_mais', name: 'Maïs en crème' },
    { id: 'ing_safran', name: 'Safran pur' }
];

// 3. Les Recettes
export const recipes = [
    { 
        id: 'rec_pate_chinois', 
        title: 'Pâté Chinois Classique', 
        ingredients: [
            { ingredientId: 'ing_boeuf', quantity: 1, unit: 'lb' }, // 1 livre = 454g
            { ingredientId: 'ing_patates', quantity: 1, unit: 'kg' },
            { ingredientId: 'ing_mais', quantity: 398, unit: 'ml' }
        ]
    },
    {
        id: 'rec_paella',
        title: 'Paella (Recette Incomplète)',
        ingredients: [
            { ingredientId: 'ing_safran', quantity: 2, unit: 'g' }, // Introuvable
            { ingredientId: 'ing_boeuf', quantity: 500, unit: 'g' }
        ]
    }
];

// 4. Prix en magasin
// IMPORTANT: Les prix sont pour la QUANTITÉ EXACTE indiquée (pas par unité)
export const prices = [
    // IGA (Cher)
    { storeId: 'iga', ingredientId: 'ing_boeuf', price: 6.99, quantity: 1, unit: 'lb' }, // 6.99$ pour 1lb
    { storeId: 'iga', ingredientId: 'ing_patates', price: 4.99, quantity: 5, unit: 'lb' }, // 4.99$ pour 5lb
    { storeId: 'iga', ingredientId: 'ing_mais', price: 1.99, quantity: 398, unit: 'ml' },

    // SUPER C (Pas cher)
    { storeId: 'super-c', ingredientId: 'ing_boeuf', price: 4.44, quantity: 1, unit: 'lb' },
    { storeId: 'super-c', ingredientId: 'ing_patates', price: 2.99, quantity: 5, unit: 'lb' },
    { storeId: 'super-c', ingredientId: 'ing_mais', price: 0.99, quantity: 398, unit: 'ml' },

    // METRO (Mix)
    { storeId: 'metro', ingredientId: 'ing_boeuf', price: 5.49, quantity: 1, unit: 'lb' },
    { storeId: 'metro', ingredientId: 'ing_patates', price: 3.49, quantity: 5, unit: 'lb' },
    { storeId: 'metro', ingredientId: 'ing_mais', price: 1.49, quantity: 398, unit: 'ml' },

    // MAXI (Économique)
    { storeId: 'maxi', ingredientId: 'ing_boeuf', price: 4.99, quantity: 1, unit: 'lb' },
    { storeId: 'maxi', ingredientId: 'ing_patates', price: 2.49, quantity: 5, unit: 'lb' },
    { storeId: 'maxi', ingredientId: 'ing_mais', price: 0.89, quantity: 398, unit: 'ml' },

    // ADONIS (Devrait être ignoré même si moins cher)
    { storeId: 'adonis', ingredientId: 'ing_boeuf', price: 1.00, quantity: 1, unit: 'lb' },
    { storeId: 'adonis', ingredientId: 'ing_patates', price: 0.99, quantity: 5, unit: 'lb' },
    { storeId: 'adonis', ingredientId: 'ing_mais', price: 0.49, quantity: 398, unit: 'ml' },

    // PROVIGO (Devrait être ignoré)
    { storeId: 'provigo', ingredientId: 'ing_boeuf', price: 5.99, quantity: 1, unit: 'lb' },
];