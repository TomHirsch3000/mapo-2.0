/**
 * categoryIcons.js — Maps icon_category and AI_primary_field values to icon image paths.
 *
 * Icons are stored in /public/icons/categories/{category}.jpg
 * Sourced from CERN CDS, NASA Image Library, and Wikimedia Commons
 * via source_category_images.py. Provenance logged in image_sources.json.
 *
 * getIconPath(node) resolves the best icon for a given paper node:
 *   1. Specific icon_category match (e.g., "atlas-detector")
 *   2. Fallback to AI_primary_field generic icon (e.g., "Quantum Chromodynamics")
 *   3. Final fallback to generic experiment icon
 */

// Specific sub-category icons (generated from paper abstracts)
// Keys must match the icon_category values from classify_icon_category.py
export const CATEGORY_ICONS = {
  // ── LHC Detectors ──
  "atlas-detector": "categories/atlas-detector.jpg",
  "cms-detector": "categories/cms-detector.jpg",
  "lhcb-detector": "categories/lhcb-detector.jpg",
  "alice-detector": "categories/alice-detector.jpg",

  // ── Tevatron ──
  "tevatron-cdf": "categories/tevatron-cdf.jpg",
  "tevatron-d0": "categories/tevatron-d0.jpg",
  "tevatron": "categories/tevatron.jpg",

  // ── HERA ──
  "hera-h1": "categories/hera-h1.jpg",
  "hera-zeus": "categories/hera-zeus.jpg",
  "hera": "categories/hera.jpg",

  // ── B-factories ──
  "belle-experiment": "categories/belle-experiment.jpg",
  "babar-experiment": "categories/babar-experiment.jpg",
  "kekb": "categories/kekb.jpg",

  // ── LEP ──
  "lep-delphi": "categories/lep-delphi.jpg",
  "lep-opal": "categories/lep-opal.jpg",
  "lep-aleph": "categories/lep-aleph.jpg",
  "lep-l3": "categories/lep-l3.jpg",
  "lep": "categories/lep.jpg",

  // ── Neutrino experiments ──
  "super-kamiokande": "categories/super-kamiokande.jpg",
  "miniboone": "categories/miniboone.jpg",
  "icecube": "categories/icecube.jpg",
  "sno": "categories/sno.jpg",
  "t2k": "categories/t2k.jpg",
  "nova-neutrino": "categories/nova-neutrino.jpg",
  "dune": "categories/dune.jpg",
  "double-chooz": "categories/double-chooz.jpg",
  "daya-bay": "categories/daya-bay.jpg",
  "borexino": "categories/borexino.jpg",
  "antares": "categories/antares.jpg",
  "minos": "categories/minos.jpg",

  // ── Heavy ion ──
  "rhic-star": "categories/rhic-star.jpg",
  "rhic-phenix": "categories/rhic-phenix.jpg",
  "rhic": "categories/rhic.jpg",

  // ── Fixed target / other ──
  "na62": "categories/na62.jpg",
  "na48-na49": "categories/na48-na49.jpg",
  "compass": "categories/compass.jpg",
  "lhc-forward": "categories/lhc-forward.jpg",
  "fermilab-fixed": "categories/fermilab-fixed.jpg",

  // ── Dark matter detectors ──
  "xenon-dm": "categories/xenon-dm.jpg",
  "lux-dm": "categories/lux-dm.jpg",
  "pandax-dm": "categories/pandax-dm.jpg",
  "cdms-dm": "categories/cdms-dm.jpg",
  "admx-axion": "categories/admx-axion.jpg",

  // ── Gravitational waves / cosmic ray / space ──
  "ligo-gw": "categories/ligo-gw.jpg",
  "auger-cosmic": "categories/auger-cosmic.jpg",
  "fermi-lat": "categories/fermi-lat.jpg",
  "hubble-telescope": "categories/hubble-telescope.jpg",
  "jwst-telescope": "categories/jwst-telescope.jpg",
  "planck-satellite": "categories/planck-satellite.jpg",

  // ── Higgs physics ──
  "higgs-discovery": "categories/higgs-discovery.jpg",
  "higgs-properties": "categories/higgs-properties.jpg",
  "higgs-search": "categories/higgs-search.jpg",
  "higgs-boson": "categories/higgs-boson.jpg",

  // ── Top quark ──
  "top-quark": "categories/top-quark.jpg",

  // ── Electroweak ──
  "w-boson": "categories/w-boson.jpg",
  "z-boson": "categories/z-boson.jpg",
  "electroweak-precision": "categories/electroweak-precision.jpg",
  "diboson": "categories/diboson.jpg",

  // ── QCD / Jets ──
  "jet-production": "categories/jet-production.jpg",
  "jet-substructure": "categories/jet-substructure.jpg",

  // ── Heavy quarks & exotic hadrons ──
  "charmonium": "categories/charmonium.jpg",
  "bottomonium": "categories/bottomonium.jpg",
  "tetraquark": "categories/tetraquark.jpg",
  "pentaquark": "categories/pentaquark.jpg",
  "exotic-hadrons": "categories/exotic-hadrons.jpg",
  "quarkonium": "categories/quarkonium.jpg",

  // ── B / charm / kaon / pion physics ──
  "b-meson-cp": "categories/b-meson-cp.jpg",
  "b-meson-decay": "categories/b-meson-decay.jpg",
  "charm-physics": "categories/charm-physics.jpg",
  "kaon-physics": "categories/kaon-physics.jpg",
  "pion-physics": "categories/pion-physics.jpg",
  "baryon-spectroscopy": "categories/baryon-spectroscopy.jpg",

  // ── Neutrino topics ──
  "neutrino-oscillation": "categories/neutrino-oscillation.jpg",
  "neutrino-cross-section": "categories/neutrino-cross-section.jpg",
  "neutrino-mass": "categories/neutrino-mass.jpg",
  "sterile-neutrino": "categories/sterile-neutrino.jpg",
  "neutrino-astro": "categories/neutrino-astro.jpg",

  // ── Dark matter topics ──
  "dark-matter-direct": "categories/dark-matter-direct.jpg",
  "dark-matter-collider": "categories/dark-matter-collider.jpg",
  "dark-matter-indirect": "categories/dark-matter-indirect.jpg",
  "dark-matter-model": "categories/dark-matter-model.jpg",
  "dark-matter": "categories/dark-matter.jpg",

  // ── SUSY ──
  "susy-search": "categories/susy-search.jpg",
  "susy-spectrum": "categories/susy-spectrum.jpg",
  "susy": "categories/susy.jpg",

  // ── Axion ──
  "axion-search": "categories/axion-search.jpg",
  "axion": "categories/axion.jpg",

  // ── Heavy ion topics ──
  "quark-gluon-plasma": "categories/quark-gluon-plasma.jpg",
  "heavy-ion-flow": "categories/heavy-ion-flow.jpg",
  "heavy-ion": "categories/heavy-ion.jpg",

  // ── QCD topics ──
  "parton-distribution": "categories/parton-distribution.jpg",
  "fragmentation": "categories/fragmentation.jpg",
  "qcd-resummation": "categories/qcd-resummation.jpg",
  "nlo-nnlo": "categories/nlo-nnlo.jpg",

  // ── Lattice / Monte Carlo ──
  "lattice-qcd": "categories/lattice-qcd.jpg",
  "monte-carlo-sim": "categories/monte-carlo-sim.jpg",

  // ── Detector & accelerator R&D ──
  "detector-rd": "categories/detector-rd.jpg",
  "accelerator-rd": "categories/accelerator-rd.jpg",

  // ── Cosmic / CMB / gravitational ──
  "cosmic-ray": "categories/cosmic-ray.jpg",
  "cmb-observation": "categories/cmb-observation.jpg",
  "gravitational-wave": "categories/gravitational-wave.jpg",

  // ── Precision measurements ──
  "muon-g2": "categories/muon-g2.jpg",
  "edm-measurement": "categories/edm-measurement.jpg",
  "alpha-qed": "categories/alpha-qed.jpg",

  // ── BSM / rare decays ──
  "rare-decay": "categories/rare-decay.jpg",
  "bsm-search": "categories/bsm-search.jpg",

  // ── Broad fallbacks ──
  "collider-general": "categories/collider-general.jpg",
  "neutrino-general": "categories/neutrino-general.jpg",
  "qcd-general": "categories/qcd-general.jpg",
  "electroweak-general": "categories/electroweak-general.jpg",
  "hadron-general": "categories/hadron-general.jpg",
  "lepton-general": "categories/lepton-general.jpg",
  "nuclear-general": "categories/nuclear-general.jpg",
  "cosmology-general": "categories/cosmology-general.jpg",
  "astroparticle": "categories/astroparticle.jpg",
};

// Fallback icons by AI_primary_field (for papers with no specific icon_category)
export const FIELD_FALLBACK_ICONS = {
  "Quantum Chromodynamics": "categories/qcd-general.jpg",
  "Standard Model": "categories/collider-general.jpg",
  "Particle Physics": "categories/collider-general.jpg",
  "Neutrino Physics": "categories/neutrino-general.jpg",
  "Dark Matter / Energy": "categories/dark-matter.jpg",
  "String Theory": "categories/collider-general.jpg",
  "Supersymmetry": "categories/susy.jpg",
  "Heavy Ion Physics": "categories/heavy-ion.jpg",
  "Quantum Electrodynamics": "categories/lepton-general.jpg",
  "Cosmology": "categories/cosmology-general.jpg",
  "Lattice Gauge Theory": "categories/lattice-qcd.jpg",
  "High Energy Physics": "categories/collider-general.jpg",
  "Nuclear Physics": "categories/nuclear-general.jpg",
  "Astrophysics": "categories/astroparticle.jpg",
  "Astroparticle Physics": "categories/astroparticle.jpg",
};

/**
 * Resolve the icon path for a paper node.
 * Returns the path relative to /public/icons/, or null if no icon available.
 *
 * @param {Object} node - Paper node with iconCategory and primaryField properties
 * @returns {string|null} Icon path relative to /public/icons/
 */
export function getIconPath(node) {
  // 1. Try specific icon_category
  if (node.iconCategory && CATEGORY_ICONS[node.iconCategory]) {
    return CATEGORY_ICONS[node.iconCategory];
  }

  // 2. Try AI_primary_field fallback
  if (node.primaryField && FIELD_FALLBACK_ICONS[node.primaryField]) {
    return FIELD_FALLBACK_ICONS[node.primaryField];
  }

  // 3. Generic fallback
  return "categories/collider-general.jpg";
}

/**
 * Check if a node should display an icon (only experimental/phenomenological papers).
 * @param {Object} node - Paper node with paperNature property
 * @returns {boolean}
 */
export function shouldShowIcon(node) {
  return node.paperNature === "experimental" || node.paperNature === "phenomenological";
}
