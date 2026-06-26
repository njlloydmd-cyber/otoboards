import { Question, Difficulty, Subspecialty } from './types';

export const CURATED_QUESTIONS: Question[] = [
  {
    id: "cur-1",
    question: "A 45-year-old male presents with recurrent unilateral epistaxis and progressive left-sided nasal obstruction. Anterior rhinoscopy shows a red-purple, highly vascular-appearing mass in the posterior nasal cavity. Biopsy of this lesion is generally contraindicated prior to imaging due to the risk of life-threatening hemorrhage. What is the most likely diagnosis?",
    options: [
      { text: "Inverted papilloma", isCorrect: false },
      { text: "Juvenile nasopharyngeal angiofibroma", isCorrect: true },
      { text: "Esthesioneuroblastoma", isCorrect: false },
      { text: "Lobular capillary hemangioma", isCorrect: false }
    ],
    explanation: "Juvenile nasopharyngeal angiofibroma (JNA) is a benign but locally aggressive vascular tumor that typically affects adolescent males. Diagnostic biopsy should be avoided as it can cause sudden, massive hemorrhage. Classic radiology shows a vascular tumor originating from the sphenopalatine foramen pushing the posterior wall of the maxillary sinus forwards (Holman-Miller sign).",
    subspecialty: "Rhinology",
    difficulty: Difficulty.Medium,
    references: [
      {
        source: "Bailey's Head and Neck Surgery - Otolaryngology",
        chapter: "Nasal Tumors",
        page: "2412"
      }
    ]
  },
  {
    id: "cur-2",
    question: "A 38-year-old woman presents with vertical nystagmus on downward gaze and sudden vertigo when she hears loud noises (Tullio phenomenon) or when pressure is applied to her external auditory canal (Hennebert sign). Audiometry shows a low-frequency conductive hearing loss with acoustic reflexes present. Which diagnostic imaging modality is most indicated?",
    options: [
      { text: "High-resolution computed tomography (HRCT) of the temporal bones", isCorrect: true },
      { text: "Magnetic resonance imaging (MRI) of the brain and IACs with gadolinium", isCorrect: false },
      { text: "Positron emission tomography (PET)", isCorrect: false },
      { text: "Cerebral angiography", isCorrect: false }
    ],
    explanation: "The clinical presentation is highly suggestive of Superior Semicircular Canal Dehiscence (SSCD). Key findings include third-window effects (Tullio and Hennebert signs) and conductive hearing loss with intact acoustic reflexes (which rules out otosclerosis). High-resolution CT (HRCT) of the temporal bone in the planes of Stenvers and Pöschl is the gold standard diagnostic test to demonstrate the dehiscence of the bone overlying the superior semicircular canal.",
    subspecialty: "Otology",
    difficulty: Difficulty.Medium,
    references: [
      {
        source: "Cummings Otolaryngology",
        chapter: "Vestibular Disorders",
        page: "1831"
      }
    ]
  },
  {
    id: "cur-3",
    question: "During a rigid laryngoscopy, a patient is found to have a well-circumscribed orange-red lesion on the true vocal fold. Biopsy shows amyloid deposits. Which of the following stains is classically used to confirm amyloidosis, demonstrating apple-green birefringence under polarized light?",
    options: [
      { text: "Alcian Blue stain", isCorrect: false },
      { text: "Congo Red stain", isCorrect: true },
      { text: "Periodic acid–Schiff (PAS) stain", isCorrect: false },
      { text: "Masson's trichrome stain", isCorrect: false }
    ],
    explanation: "Laryngeal amyloidosis is characterized by the extracellular deposition of amorphous fibrillar proteins. Under light microscopy, Congo red staining highlights these deposits as salmon-pink or orange-red. Under polarized light, they demonstrate a characteristic apple-green birefringence.",
    subspecialty: "Laryngology",
    difficulty: Difficulty.Hard,
    references: [
      {
        source: "Cummings Otolaryngology",
        chapter: "Benign Vocal Fold Lesions",
        page: "890"
      }
    ]
  },
  {
    id: "cur-4",
    question: "A 62-year-old female presents with a slowly growing, painless lump in her left cheek parotid region. Fine needle aspiration (FNA) is performed, demonstrating a benign salivary gland neoplasm with a mix of epithelial, myoepithelial, and stromal (mucoid, chondroid, or myxoid) components. What is the most common benign salivary gland tumor matching this description?",
    options: [
      { text: "Warthin's tumor (Papillary cystadenoma lymphomatosum)", isCorrect: false },
      { text: "Pleomorphic adenoma (Benign mixed tumor)", isCorrect: true },
      { text: "Mucoepidermoid carcinoma", isCorrect: false },
      { text: "Adenoid cystic carcinoma", isCorrect: false }
    ],
    explanation: "Pleomorphic adenoma (benign mixed tumor) is the most common salivary gland neoplasm, accounting for about 60% of parotid tumors. Histologically, it characteristically displays a biphasic appearance containing both ductal epithelial/myoepithelial cells and a mesenchymal/stromal matrix (chondromyxoid background).",
    subspecialty: "Head & Neck Surgery",
    difficulty: Difficulty.Easy,
    references: [
      {
        source: "Bailey's Head and Neck Surgery",
        chapter: "Salivary Gland Pathology"
      }
    ]
  },
  {
    id: "cur-5",
    question: "A newborn is noted to have severe respiratory distress shortly after birth, which resolves when crying but worsens immediately during feeding. Attempts to pass a small French catheter through the nasal cavity into the nasopharynx fail bilaterally. What is the immediate first-line airway stabilization management for this patient?",
    options: [
      { text: "Systemic high-dose steroid therapy", isCorrect: false },
      { text: "Nasal continuous positive airway pressure (CPAP)", isCorrect: false },
      { text: "Placement of an oral McGovern nipple", isCorrect: true },
      { text: "Emergent surgical repair via transpalatal route", isCorrect: false }
    ],
    explanation: "This presentation is classic for bilateral choanal atresia. Newborns are obligate nasal breathers, so bilateral atresia results in cyclic respiratory distress (crying opens the oral airway, relieving dynamic airway obstruction, but closing the mouth to feed causes asphyxia). The immediate, life-saving airway stabilization method is the placement of an oral McGovern nipple, which establishes an oral airway. Definite surgical correction is performed electively once stabilized.",
    subspecialty: "Pediatric Otolaryngology",
    difficulty: Difficulty.Hard,
    references: [
      {
        source: "Cummings Pediatric Otolaryngology",
        chapter: "Congenital Nasal Anomalies"
      }
    ]
  },
  {
    id: "cur-6",
    question: "A 24-year-old man sustains a nasal fracture and presents with progressive worsening nasal congestion and severe, localized pain over 48 hours. Examination reveals a bilateral soft, fluctuant, purplish mass expansion of the septum causing total nasal airway obstruction. What is the immediate treatment of choice?",
    options: [
      { text: "Closed reduction of the nasal bones within 10 days", isCorrect: false },
      { text: "Urgent incision, drainage, and anterior nasal packing", isCorrect: true },
      { text: "7-day course of high-dose oral prednisone", isCorrect: false },
      { text: "Broad-spectrum oral antibiotics alone", isCorrect: false }
    ],
    explanation: "The patient has a septal hematoma, which is an emergency. Delayed evacuation of the blood pools blocks blood supply from the septal perichondrium to the septal cartilage, leading to cartilage necrosis, septal perforation, saddle nose deformity, and potential infection/abscess. Immediate management is wide-bore dual incision and drainage, placement of anterior nasal packing or septal splints to prevent re-accumulation, and initiation of prophylactic antibiotics.",
    subspecialty: "Facial Plastics & Reconstructive Surgery",
    difficulty: Difficulty.Medium,
    references: [
      {
        source: "Cummings Otolaryngology",
        chapter: "Nasal Trauma"
      }
    ]
  },
  {
    id: "cur-7",
    question: "A 55-year-old diabetic patient presents with deep, boring otalgia, foul-smelling otorrhea, and cranial nerve VII palsy. Otoscopy reveals granulation tissue at the bony-cartilaginous junction of the external auditory canal. What is the gold-standard initial antibiotic choice for this condition?",
    options: [
      { text: "Oral amoxicillin-clavulanate", isCorrect: false },
      { text: "Intravenous piperacillin-tazobactam or ciprofloxacin", isCorrect: true },
      { text: "Oral erythromycin", isCorrect: false },
      { text: "Intramuscular ceftriaxone", isCorrect: false }
    ],
    explanation: "This patient has necrotizing (malignant) otitis externa, an osteomyelitis of the skull base, most commonly caused by Pseudomonas aeruginosa in elderly diabetic or immunocompromised individuals. Granulation tissue in the EAC is pathognomonic. Treatment requires long-term (minimum 6 weeks) antipseudomonal IV or high-dose oral therapy (such as ciprofloxacin, ceftazidime, or piperacillin-tazobactam) monitored by inflammatory markers (ESR, CRP) and gallium or technetium bone scans.",
    subspecialty: "Otology",
    difficulty: Difficulty.Medium,
    references: [
      {
        source: "Cummings Otolaryngology",
        chapter: "Infections of the External Ear",
        page: "1230"
      }
    ]
  },
  {
    id: "cur-8",
    question: "A 54-year-old male is diagnosed with early-stage laryngeal cancer of the true vocal folds. To determine whether the tumor has invaded the thyroid cartilage, which of the following is the most sensitive diagnostic imaging modality?",
    options: [
      { text: "Magnetic Resonance Imaging (MRI)", isCorrect: true },
      { text: "Contrast-Enhanced Computed Tomography (CECT)", isCorrect: false },
      { text: "Ultrasound of the neck", isCorrect: false },
      { text: "Barium swallow study", isCorrect: false }
    ],
    explanation: "To evaluate thyroid or cricoid cartilage invasion in laryngeal tumors, MRI is highly sensitive, particularly for identifying early cartilage invasion. T2-weighted and post-gadolinium T1-weighted images show cartilage involvement prior to CT which may be confounded by irregular/non-uniform ossification centers.",
    subspecialty: "Head & Neck Surgery",
    difficulty: Difficulty.Hard,
    references: [
      {
        source: "Cummings Otolaryngology",
        chapter: "Malignant Laryngeal Tumors"
      }
    ]
  },
  {
    id: "cur-9",
    question: "A 4-year-old child is brought to the emergency department after a sudden choking episode. The child is drooling, leaning forward in a tripod position, with inspiratory stridor, high fever, and severe dysphagia. A lateral neck radiograph shows marked thickening of the epiglottis, demonstrating the thumbprint sign. Which pathogen is the classic cause of this presentation?",
    options: [
      { text: "Streptococcus pneumoniae", isCorrect: false },
      { text: "Haemophilus influenzae type B (Hib)", isCorrect: true },
      { text: "Staphylococcus aureus", isCorrect: false },
      { text: "Respiratory syncytial virus (RSV)", isCorrect: false }
    ],
    explanation: "Acute epiglottis presents with rapid-onset high fever, drooling, clinical tripod positioning, stridor, and severe dysphagia. The lateral neck radiograph classically demonstrates the thumbprint sign. Historically, Haemophilus influenzae type B (Hib) was the primary causative agent, though its incidence has plummeted since the introduction of the Hib conjugate vaccine.",
    subspecialty: "Pediatric Otolaryngology",
    difficulty: Difficulty.Easy,
    references: [
      {
        source: "Cummings Pediatric Otolaryngology",
        chapter: "Acute Inflammatory Airway Diseases"
      }
    ]
  },
  {
    id: "cur-10",
    question: "A 64-year-old patient presents with painless left-sided vocal fold paralysis. High-resolution chest and neck CT imaging is ordered to trace the course of the recurrent laryngeal nerve (RLN). Which anatomical landmark determines the loop point of the left RLN?",
    options: [
      { text: "It loops beneath the right subclavian artery", isCorrect: false },
      { text: "It loops beneath the aortic arch, lateral to the ligamentum arteriosum", isCorrect: true },
      { text: "It loops beneath the hyoid bone", isCorrect: false },
      { text: "It loops beneath the common carotid bifurcation", isCorrect: false }
    ],
    explanation: "The left recurrent laryngeal nerve branches from the vagus nerve (CN X) as it crosses the aortic arch. It then loops underneath the aortic arch, immediately posterior to the ligamentum arteriosum, and ascends in the tracheoesophageal groove. Because of this longer mediastinal course, left vocal fold paralysis is more commonly due to mediastinal or thoracic pathology (e.g., lung cancer, aortic aneurysm) than the right RLN, which loops higher under the right subclavian artery.",
    subspecialty: "Laryngology",
    difficulty: Difficulty.Medium,
    references: [
      {
        source: "Gray's Anatomy",
        chapter: "The Recurrent Laryngeal Nerve Course"
      }
    ]
  },
  {
    id: "cur-11",
    question: "A patient presents with rhinorrhea and nasal itching. Skin prick testing confirms allergic rhinitis. According to the Clinical Practice Guidelines of the AAO-HNS, which class of pharmacotherapy is recommended as the most effective first-line monotherapy for patients with clinically significant allergic rhinitis symptoms?",
    options: [
      { text: "First-generation oral antihistamines", isCorrect: false },
      { text: "Intranasal corticosteroids", isCorrect: true },
      { text: "Oral leukotriene receptor antagonists (e.g., Montelukast)", isCorrect: false },
      { text: "Intranasal saline sprays alone", isCorrect: false }
    ],
    explanation: "The AAO-HNS Clinical Practice Guidelines for Allergic Rhinitis recommend intranasal corticosteroids as the single most effective monotherapy for patients with clinically significant symptoms. They are superior to oral second-generation antihistamines and montelukast in relieving nasal congestion, rhinorrhea, and ocular symptoms.",
    subspecialty: "Rhinology",
    difficulty: Difficulty.Easy,
    references: [
      {
        source: "AAO-HNS Allergic Rhinitis Clinical Practice Guideline",
        page: "S4-S10"
      }
    ]
  },
  {
    id: "cur-12",
    question: "A surgeon is performing a subtotal parotidectomy. To identify the main trunk of the facial nerve (CN VII) as it exits the stylomastoid foramen, which of the following anatomical landmarks is considered the most reliable during surgery?",
    options: [
      { text: "The tympanomastoid suture line", isCorrect: true },
      { text: "The lateral border of the masseter muscle", isCorrect: false },
      { text: "The facial vein", isCorrect: false },
      { text: "The posterior belly of the digastric muscle (medial border)", isCorrect: false }
    ],
    explanation: "The tympanomastoid suture line is an extremely reliable landmark, as the main trunk of the facial nerve is located approximately 6-8 mm deep to the suture line. Other landmarks include the pointer (cartilaginous external auditory canal pointing toward the nerve at 1 cm deep), the posterior belly of the digastric muscle, and the styloid process.",
    subspecialty: "Head & Neck Surgery",
    difficulty: Difficulty.Hard,
    references: [
      {
        source: "Cummings Otolaryngology",
        chapter: "Parotid Surgery and Facial Nerve Preservation"
      }
    ]
  }
];

export function getFilteredCuratedQuestions(
  count: number,
  difficulty: Difficulty,
  subspecialty: Subspecialty
): Question[] {
  let list = [...CURATED_QUESTIONS];
  
  if (difficulty !== Difficulty.Mixed) {
    list = list.filter(q => q.difficulty === difficulty);
  }
  
  if (subspecialty !== Subspecialty.Mixed) {
    list = list.filter(q => {
      // Handle subspecialty matching roughly based on strings
      const qSub = q.subspecialty.toLowerCase();
      const spec = subspecialty.toLowerCase();
      return qSub.includes(spec) || spec.includes(qSub);
    });
  }
  
  // If we ended up with no matches (which can happen under strict filters since we only have 12 questions),
  // fall back to matching as much as possible, or return a random selection from our pool to ensure a great study session.
  if (list.length === 0) {
    list = [...CURATED_QUESTIONS];
  }
  
  // Shuffle list
  list.sort(() => Math.random() - 0.5);
  
  return list.slice(0, Math.min(count, list.length));
}
