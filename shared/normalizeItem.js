function normalizeItemName(item) {
  if (!item || typeof item !== "string") {
    return item;
  }

  let value = item
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

  // Common irregular / grocery plural forms
  const irregular = {
    potatoes: "potato",
    tomatoes: "tomato",
    mangoes: "mango",
    leaves: "leaf",
    loaves: "loaf",
    knives: "knife",
    wives: "wife",
    children: "child",
  };

  if (irregular[value]) {
    return irregular[value];
  }

  // Already singular / uncountable/common words
  const unchanged = new Set([
    "rice",
    "wheat",
    "milk",
    "water",
    "sugar",
    "salt",
    "flour",
    "oil",
    "gas",
    "glass",
    "fish",
    "bread",
  ]);

  if (unchanged.has(value)) {
    return value;
  }

  // -ies → -y
  // e.g. berries → berry
  if (value.endsWith("ies") && value.length > 3) {
    return value.slice(0, -3) + "y";
  }

  // -ves → common singular forms
  if (value.endsWith("ves")) {
    const special = {
      leaves: "leaf",
      knives: "knife",
      loaves: "loaf",
    };

    if (special[value]) {
      return special[value];
    }
  }

  // -oes → usually remove "es"
  // potatoes/tomatoes are already handled above
  if (value.endsWith("oes") && value.length > 3) {
    return value.slice(0, -2);
  }

  // -ches, -shes, -xes, -zes, -sses
  if (
    value.endsWith("ches") ||
    value.endsWith("shes") ||
    value.endsWith("xes") ||
    value.endsWith("zes") ||
    value.endsWith("sses")
  ) {
    return value.slice(0, -2);
  }

  // Regular plurals
  if (value.endsWith("s") && !value.endsWith("ss")) {
    return value.slice(0, -1);
  }

  return value;
}

module.exports = {
  normalizeItemName,
};