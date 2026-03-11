/* UP TO SPEED — Landing Page Interactions */

(function () {
  'use strict';

  // ─── Theme toggle + system preference + screenshot swapping ───
  const THEME_STORAGE_KEY = 'uts-landing-theme';
  const THEME_DARK = 'dark';
  const THEME_LIGHT = 'light';
  const root = document.documentElement;
  const themeToggleButtons = Array.from(document.querySelectorAll('[data-theme-toggle]'));
  const themeImages = Array.from(document.querySelectorAll('[data-theme-image]'));
  const colorSchemeQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  const normalizeTheme = (value) => (
    value === THEME_DARK || value === THEME_LIGHT ? value : null
  );

  const getStoredTheme = () => {
    try {
      return normalizeTheme(window.localStorage.getItem(THEME_STORAGE_KEY));
    } catch {
      return null;
    }
  };

  const setStoredTheme = (theme) => {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Swallow storage failures (private mode, disabled storage).
    }
  };

  const getSystemTheme = () => (
    colorSchemeQuery && colorSchemeQuery.matches ? THEME_DARK : THEME_LIGHT
  );

  const getCurrentTheme = () => (
    normalizeTheme(root.getAttribute('data-theme')) || getSystemTheme()
  );

  let hasManualThemePreference = Boolean(getStoredTheme());

  const updateThemeImages = (theme) => {
    themeImages.forEach((image) => {
      const nextSrc = theme === THEME_LIGHT ? image.dataset.themeLightSrc : image.dataset.themeDarkSrc;
      if (!nextSrc || image.getAttribute('src') === nextSrc) return;
      image.setAttribute('src', nextSrc);
    });
  };

  const updateThemeToggleUi = (theme) => {
    themeToggleButtons.forEach((button) => {
      const buttonTheme = normalizeTheme(button.dataset.themeToggle);
      const isActive = buttonTheme === theme;
      button.classList.toggle('active', isActive);
      button.setAttribute('aria-pressed', String(isActive));
    });
  };

  const applyTheme = (theme) => {
    const resolvedTheme = normalizeTheme(theme) || THEME_DARK;
    root.setAttribute('data-theme', resolvedTheme);
    root.style.colorScheme = resolvedTheme;
    updateThemeImages(resolvedTheme);
    updateThemeToggleUi(resolvedTheme);
  };

  themeToggleButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const nextTheme = normalizeTheme(button.dataset.themeToggle);
      if (!nextTheme) return;
      if (nextTheme === getCurrentTheme()) return;
      hasManualThemePreference = true;
      setStoredTheme(nextTheme);
      applyTheme(nextTheme);
    });
  });

  if (colorSchemeQuery) {
    const handleSystemThemeChange = (event) => {
      if (hasManualThemePreference) return;
      applyTheme(event.matches ? THEME_DARK : THEME_LIGHT);
    };

    if (typeof colorSchemeQuery.addEventListener === 'function') {
      colorSchemeQuery.addEventListener('change', handleSystemThemeChange);
    } else if (typeof colorSchemeQuery.addListener === 'function') {
      colorSchemeQuery.addListener(handleSystemThemeChange);
    }
  }

  applyTheme(getStoredTheme() || getCurrentTheme());

  // ─── Hero intro tease ───
  const heroIntro = document.querySelector('.hero.hero-intro');
  if (heroIntro) {
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const introDelayMs = prefersReducedMotion ? 0 : 1200;
    const preloadText = heroIntro.querySelector('#heroPreloadText');
    const preloadLines = [
      'pushing deadlines',
      'extending tasks',
      'reassigning work',
      'dodging schedule collisions',
      'stretching review windows',
      'reshuffling priorities'
    ];
    const randomPreloadLine = preloadLines[Math.floor(Math.random() * preloadLines.length)] || '';
    if (preloadText && randomPreloadLine) preloadText.textContent = randomPreloadLine;

    const startHeroWordCycle = () => {
      const typedWord = heroIntro.querySelector('.hero-typed-word');
      if (!typedWord) return;

      const words = (typedWord.dataset.heroWords || typedWord.textContent || '')
        .split('|')
        .map(word => word.trim())
        .filter(Boolean);

      if (!words.length) return;

      typedWord.textContent = words[0];

      if (prefersReducedMotion || words.length < 2) return;

      let wordIndex = 0;
      let phase = 'hold';
      let charIndex = words[wordIndex].length;

      const randomBetween = (minMs, maxMs) => (
        Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs
      );

      const getDeleteDelay = () => {
        let delay = randomBetween(30, 58);
        if (Math.random() < 0.16) delay += randomBetween(24, 84);
        return delay;
      };

      const getTypeDelay = (word, nextCharIndex) => {
        const progress = word.length > 0 ? nextCharIndex / word.length : 0;
        const char = word.charAt(Math.max(0, nextCharIndex - 1));
        let delay = randomBetween(48, 88);

        if (progress < 0.28) delay += randomBetween(8, 26);
        if (progress > 0.76) delay += randomBetween(12, 34);
        if (Math.random() < 0.18) delay += randomBetween(26, 102);
        if (/[.,!?]/.test(char)) delay += randomBetween(70, 130);

        return delay;
      };

      const scheduleTick = (delayMs) => {
        window.setTimeout(runTick, delayMs);
      };

      const runTick = () => {
        if (phase === 'hold') {
          phase = 'deleting';
          scheduleTick(randomBetween(760, 1180));
          return;
        }

        if (phase === 'deleting') {
          const currentWord = words[wordIndex];
          if (charIndex > 0) {
            charIndex -= 1;
            typedWord.textContent = currentWord.slice(0, charIndex);
            scheduleTick(getDeleteDelay());
            return;
          }
          wordIndex = (wordIndex + 1) % words.length;
          phase = 'typing';
          scheduleTick(randomBetween(130, 250));
          return;
        }

        const nextWord = words[wordIndex];
        if (charIndex < nextWord.length) {
          charIndex += 1;
          typedWord.textContent = nextWord.slice(0, charIndex);
          scheduleTick(getTypeDelay(nextWord, charIndex));
          return;
        }

        phase = 'hold';
        scheduleTick(randomBetween(1280, 1900));
      };

      scheduleTick(randomBetween(1500, 2200));
    };

    window.setTimeout(() => {
      heroIntro.classList.add('hero-ready');
      const preload = heroIntro.querySelector('.hero-preload');
      if (preload) preload.setAttribute('aria-hidden', 'true');
      startHeroWordCycle();
    }, introDelayMs);
  }

  // ─── Scroll-triggered fade-ins ───
  const fadeTargets = document.querySelectorAll(
    '.feature-card, .view-card, .speed-blueprint, .speed-card, .roadmap-phase, .waitlist-card, .fr-form, .showcase-card, .showcase-featured-card, .showcase-category'
  );

  fadeTargets.forEach(el => el.classList.add('fade-in'));

  const fadeObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          fadeObserver.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.1, rootMargin: '0px 0px -40px 0px' }
  );

  fadeTargets.forEach(el => fadeObserver.observe(el));

  // ─── Stagger fade-in delays ───
  document.querySelectorAll('.features-grid .feature-card').forEach((card, i) => {
    card.style.transitionDelay = `${i * 0.07}s`;
  });

  document.querySelectorAll('.views-showcase .view-card').forEach((card, i) => {
    card.style.transitionDelay = `${i * 0.1}s`;
  });

  document.querySelectorAll('.roadmap-phase').forEach((phase, i) => {
    phase.style.transitionDelay = `${i * 0.12}s`;
  });

  document.querySelectorAll('.speed-cards .speed-card').forEach((card, i) => {
    card.style.transitionDelay = `${i * 0.08}s`;
  });

  // ─── Glass pill nav — solidify on scroll ───
  const nav = document.querySelector('.nav');

  if (nav) {
    const syncNavScrollState = () => {
      nav.classList.toggle('is-scrolled', window.scrollY > 60);
    };

    syncNavScrollState();
    window.addEventListener('scroll', syncNavScrollState, { passive: true });
  }

  // ─── Active nav link highlighting + consistent section jumps ───
  const sections = Array.from(document.querySelectorAll('section[id]'));
  const navLinks = Array.from(document.querySelectorAll('.nav-links a'));
  const normalizePath = (pathname = '') => pathname
    .replace(/\/index\.html$/i, '/')
    .replace(/\/+$/, '') || '/';
  const currentPath = normalizePath(window.location.pathname);

  const getSectionHash = (link) => {
    const href = link?.getAttribute('href');
    if (!href || !href.includes('#')) return '';
    try {
      const url = new URL(href, window.location.href);
      if (normalizePath(url.pathname) !== currentPath) return '';
      return url.hash || '';
    } catch {
      return '';
    }
  };

  const sectionNavLinks = navLinks.filter(link => Boolean(getSectionHash(link)));

  const setActiveSectionLink = (hash) => {
    sectionNavLinks.forEach(link => {
      const isActive = getSectionHash(link) === hash;
      link.classList.toggle('active', isActive);
      if (isActive) {
        link.setAttribute('aria-current', 'location');
      } else {
        link.removeAttribute('aria-current');
      }
    });
  };

  const scrollToSection = (hash, { updateHistory = true } = {}) => {
    if (!hash) return;
    const target = document.querySelector(hash);
    if (!target) return;

    const navOffset = (nav?.offsetHeight || 0) + 24;
    const top = window.scrollY + target.getBoundingClientRect().top - navOffset;
    window.scrollTo({ top: Math.max(top, 0), behavior: 'smooth' });

    if (updateHistory) {
      const url = new URL(window.location.href);
      url.hash = hash.slice(1);
      window.history.pushState({}, '', url);
    }
  };

  sectionNavLinks.forEach(link => {
    link.addEventListener('click', (event) => {
      const hash = getSectionHash(link);
      if (!hash) return;
      event.preventDefault();
      setActiveSectionLink(hash);
      scrollToSection(hash);
    });
  });

  if (window.location.hash) {
    window.setTimeout(() => {
      setActiveSectionLink(window.location.hash);
      scrollToSection(window.location.hash, { updateHistory: false });
    }, 0);
  }

  const sectionObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const id = entry.target.getAttribute('id');
          setActiveSectionLink(`#${id}`);
        }
      });
    },
    { threshold: 0.3, rootMargin: '-56px 0px -50% 0px' }
  );

  sections.forEach(section => sectionObserver.observe(section));

  // ─── Form validation (JustValidate + strict rules) ───
  const strictEmailPattern = /^(?=.{6,254}$)(?=.{1,64}@)[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

  const normalizeText = (value) => (typeof value === 'string' ? value.trim() : '');

  const isStrictEmail = (value) => {
    const email = normalizeText(value);
    if (!email || !strictEmailPattern.test(email)) return false;
    if (email.includes('..')) return false;
    const [local] = email.split('@');
    return Boolean(local && !local.startsWith('.') && !local.endsWith('.'));
  };

  const hasMeaningfulFeatureText = (value) => {
    const text = normalizeText(value);
    if (text.length < 30) return false;
    const words = text.split(/\s+/).filter(Boolean);
    return words.length >= 6;
  };

  const setFeedbackState = (field, { isValid, message, show } = {}) => {
    if (!field) return;
    const feedback = field.id ? document.getElementById(`${field.id}-feedback`) : null;

    field.classList.remove('is-valid', 'is-invalid');
    field.removeAttribute('aria-invalid');

    if (show && isValid === true) {
      field.classList.add('is-valid');
    } else if (show && isValid === false) {
      field.classList.add('is-invalid');
      field.setAttribute('aria-invalid', 'true');
    }

    if (!feedback) return;
    feedback.classList.remove('is-valid', 'is-invalid');

    if (show && message) {
      feedback.textContent = message;
      feedback.classList.add(isValid ? 'is-valid' : 'is-invalid');
    } else {
      feedback.textContent = '';
    }
  };

  const toFieldArray = (fields) => (
    Object.values(fields || {}).filter(field => field && field.elem instanceof Element)
  );

  const syncFeedbackFromValidator = (fields) => {
    toFieldArray(fields).forEach((fieldState) => {
      const field = fieldState.elem;
      const value = normalizeText(field.value);
      const touched = fieldState.touched || field.dataset.touched === 'true';
      const hasInteracted = field.dataset.interacted === 'true';
      const showError = touched && fieldState.isValid === false;
      const showSuccess = Boolean(value) && fieldState.isValid === true && (hasInteracted || touched);

      let message = '';
      if (showError) {
        message = fieldState.errorMessage || field.dataset.requiredMessage || 'Please review this field.';
      } else if (showSuccess) {
        message = fieldState.successMessage || field.dataset.validMessage || 'Looks good.';
      }

      setFeedbackState(field, {
        isValid: showError ? false : showSuccess ? true : null,
        message,
        show: showError || showSuccess
      });
    });
  };

  const setupFallbackValidation = () => {
    const waitlistForm = document.querySelector('.waitlist-form');
    const waitlistEmail = waitlistForm?.querySelector('#waitlist-email');
    const waitlistButton = waitlistForm?.querySelector('button[type="submit"]');
    const waitlistCard = waitlistForm?.closest('.waitlist-card');

    const frForm = document.querySelector('.fr-form');
    const frEmail = frForm?.querySelector('#fr-email');
    const frFeature = frForm?.querySelector('#fr-feature');
    const frRole = frForm?.querySelector('#fr-role');
    const frButton = frForm?.querySelector('button[type="submit"]');

    const updateWaitlistButton = () => {
      if (!waitlistButton || !waitlistEmail) return;
      const canSubmit = isStrictEmail(waitlistEmail.value);
      waitlistButton.disabled = !canSubmit;
      waitlistButton.setAttribute('aria-disabled', String(!canSubmit));
      waitlistCard?.classList.toggle('is-ready', canSubmit);
    };

    const updateFrButton = () => {
      if (!frButton || !frEmail || !frFeature || !frRole) return;
      const roleValue = normalizeText(frRole.value);
      const roleValid = !roleValue || ['coordinator', 'producer', 'supervisor', 'lead', 'artist', 'pipeline', 'other'].includes(roleValue);
      const canSubmit = isStrictEmail(frEmail.value) && hasMeaningfulFeatureText(frFeature.value) && roleValid;
      frButton.disabled = !canSubmit;
      frButton.setAttribute('aria-disabled', String(!canSubmit));
    };

    updateWaitlistButton();
    updateFrButton();

    waitlistEmail?.addEventListener('input', updateWaitlistButton);
    frEmail?.addEventListener('input', updateFrButton);
    frFeature?.addEventListener('input', updateFrButton);
    frRole?.addEventListener('change', updateFrButton);

    waitlistForm?.addEventListener('submit', (event) => {
      if (!isStrictEmail(waitlistEmail?.value || '')) {
        event.preventDefault();
        setFeedbackState(waitlistEmail, {
          isValid: false,
          message: 'Use a valid studio email format, like name@studio.com.',
          show: true
        });
      }
    });

    frForm?.addEventListener('submit', (event) => {
      const roleValue = normalizeText(frRole?.value || '');
      const roleValid = !roleValue || ['coordinator', 'producer', 'supervisor', 'lead', 'artist', 'pipeline', 'other'].includes(roleValue);
      const valid = isStrictEmail(frEmail?.value || '') && hasMeaningfulFeatureText(frFeature?.value || '') && roleValid;
      if (!valid) {
        event.preventDefault();
      }
    });
  };

  const setupJustValidateForms = () => {
    if (typeof window.JustValidate !== 'function') {
      setupFallbackValidation();
      return;
    }

    const waitlistForm = document.querySelector('.waitlist-form');
    const waitlistEmail = waitlistForm?.querySelector('#waitlist-email');
    const waitlistButton = waitlistForm?.querySelector('button[type="submit"]');
    const waitlistCard = waitlistForm?.closest('.waitlist-card');

    const updateWaitlistButton = () => {
      if (!waitlistButton || !waitlistEmail) return;
      const canSubmit = isStrictEmail(waitlistEmail.value);
      waitlistButton.disabled = !canSubmit;
      waitlistButton.setAttribute('aria-disabled', String(!canSubmit));
      waitlistCard?.classList.toggle('is-ready', canSubmit);
    };

    if (waitlistForm && waitlistEmail) {
      const waitlistValidator = new window.JustValidate(waitlistForm, {
        validateBeforeSubmitting: true,
        focusInvalidField: true,
        errorFieldCssClass: 'is-invalid',
        successFieldCssClass: 'is-valid',
        errorLabelCssClass: 'is-invalid',
        successLabelCssClass: 'is-valid'
      });

      waitlistValidator
        .addField(
          '#waitlist-email',
          [
            {
              rule: 'required',
              errorMessage: waitlistEmail.dataset.requiredMessage || 'Please add your email address.'
            },
            {
              validator: (value) => isStrictEmail(value),
              errorMessage: 'Use a valid studio email format, like name@studio.com.'
            }
          ],
          {
            errorsContainer: '#waitlist-email-feedback',
            successMessage: waitlistEmail.dataset.validMessage || 'Nice, that email looks good.'
          }
        )
        .onValidate(({ fields }) => {
          syncFeedbackFromValidator(fields);
          updateWaitlistButton();
        })
        .onFail((fields) => {
          syncFeedbackFromValidator(fields);
          updateWaitlistButton();
        })
        .onSuccess((event) => {
          if (event?.target && typeof event.target.submit === 'function') event.target.submit();
        });

      waitlistEmail.addEventListener('blur', () => {
        waitlistEmail.dataset.interacted = 'true';
        waitlistEmail.dataset.touched = 'true';
        waitlistValidator.revalidateField(waitlistEmail).catch(() => {});
      });

      waitlistEmail.addEventListener('input', () => {
        waitlistEmail.dataset.interacted = 'true';
        if (waitlistEmail.dataset.touched === 'true') {
          waitlistValidator.revalidateField(waitlistEmail).catch(() => {});
        }
        updateWaitlistButton();
      });

      updateWaitlistButton();
    }

    const frForm = document.querySelector('.fr-form');
    const frEmail = frForm?.querySelector('#fr-email');
    const frRole = frForm?.querySelector('#fr-role');
    const frFeature = frForm?.querySelector('#fr-feature');
    const frButton = frForm?.querySelector('button[type="submit"]');

    const updateFrButton = () => {
      if (!frButton || !frEmail || !frRole || !frFeature) return;
      const roleValue = normalizeText(frRole.value);
      const roleValid = !roleValue || ['coordinator', 'producer', 'supervisor', 'lead', 'artist', 'pipeline', 'other'].includes(roleValue);
      const canSubmit = isStrictEmail(frEmail.value) && hasMeaningfulFeatureText(frFeature.value) && roleValid;
      frButton.disabled = !canSubmit;
      frButton.setAttribute('aria-disabled', String(!canSubmit));
    };

    if (frForm && frEmail && frRole && frFeature) {
      const frValidator = new window.JustValidate(frForm, {
        validateBeforeSubmitting: true,
        focusInvalidField: true,
        errorFieldCssClass: 'is-invalid',
        successFieldCssClass: 'is-valid',
        errorLabelCssClass: 'is-invalid',
        successLabelCssClass: 'is-valid'
      });

      frValidator
        .addField(
          '#fr-email',
          [
            {
              rule: 'required',
              errorMessage: frEmail.dataset.requiredMessage || 'Please add your email address.'
            },
            {
              validator: (value) => isStrictEmail(value),
              errorMessage: 'Use a valid studio email format, like name@studio.com.'
            }
          ],
          {
            errorsContainer: '#fr-email-feedback',
            successMessage: frEmail.dataset.validMessage || 'Great, we can follow up with you.'
          }
        )
        .addField(
          '#fr-role',
          [
            {
              validator: (value) => {
                const v = normalizeText(value);
                return !v || ['coordinator', 'producer', 'supervisor', 'lead', 'artist', 'pipeline', 'other'].includes(v);
              },
              errorMessage: 'Please choose a role from the list.'
            }
          ],
          {
            errorsContainer: '#fr-role-feedback',
            successMessage: frRole.dataset.validMessage || 'Perfect, thanks for sharing your role.'
          }
        )
        .addField(
          '#fr-feature',
          [
            {
              rule: 'required',
              errorMessage: frFeature.dataset.requiredMessage || 'Please tell us what you would like to see.'
            },
            {
              validator: (value) => hasMeaningfulFeatureText(value),
              errorMessage: 'Please share at least 30 characters and 6 words so we can act on it.'
            }
          ],
          {
            errorsContainer: '#fr-feature-feedback',
            successMessage: frFeature.dataset.validMessage || 'Love it, this is clear and actionable.'
          }
        )
        .onValidate(({ fields }) => {
          syncFeedbackFromValidator(fields);
          updateFrButton();
        })
        .onFail((fields) => {
          syncFeedbackFromValidator(fields);
          updateFrButton();
        })
        .onSuccess((event) => {
          if (event?.target && typeof event.target.submit === 'function') event.target.submit();
        });

      [frEmail, frRole, frFeature].forEach((field) => {
        const inputEvent = field.tagName === 'SELECT' ? 'change' : 'input';

        field.addEventListener('blur', () => {
          field.dataset.interacted = 'true';
          field.dataset.touched = 'true';
          frValidator.revalidateField(field).catch(() => {});
        });

        field.addEventListener(inputEvent, () => {
          field.dataset.interacted = 'true';
          if (field.dataset.touched === 'true') {
            frValidator.revalidateField(field).catch(() => {});
          }
          updateFrButton();
        });
      });

      updateFrButton();
    }
  };

  setupJustValidateForms();
})();
