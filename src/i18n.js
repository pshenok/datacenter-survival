import { EN_TRANSLATIONS } from "./locales/en.js";
import { RU_TRANSLATIONS } from "./locales/ru.js";

/**
 * Simple i18n manager for the game
 */
export class I18nManager {
    constructor() {
        this.currentLocale = (typeof localStorage !== 'undefined' ? localStorage.getItem('dc_locale') : null) || 'en';
        this.translations = {
            en: EN_TRANSLATIONS,
            ru: RU_TRANSLATIONS,
        };
    }

    setLocale(locale) {
        console.log(locale);
        console.log(this.translations);
        if (this.translations[locale]) {
            this.currentLocale = locale;
            if (typeof localStorage !== 'undefined') localStorage.setItem('dc_locale', locale);
            this.applyTranslations();
            // Dispatch event for components that need to update manually
            if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('localeChanged', { detail: locale }));
        }
    }

    t(key, variables = {}) {
        let text = this.translations[this.currentLocale][key] || key;
        
        // Handle variable interpolation
        Object.keys(variables).forEach(varName => {
            text = text.replace(`{${varName}}`, variables[varName]);
        });
        
        return text;
    }

    applyTranslations() {
        // Update all elements with data-i18n attribute
        document.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.getAttribute('data-i18n');
            const translation = this.t(key);
            
            // Handle special cases like placeholder
            if (el.tagName === 'INPUT' && (el.type === 'text' || el.type === 'number')) {
                el.placeholder = translation;
            } else {
                // For other elements, update innerHTML or textContent
                // If it contains HTML tags (like <b>), use innerHTML
                if (translation.includes('<')) {
                    el.innerHTML = translation;
                } else {
                    el.textContent = translation;
                }
            }
        });

        // Update all elements with data-i18n-title attribute
        document.querySelectorAll('[data-i18n-title]').forEach(el => {
            const titleKey = el.getAttribute('data-i18n-title');
            el.setAttribute('title', this.t(titleKey));
        });

        // Update document title
        document.title = this.t('title');

        // Update language select if it exists
        const langSelect = document.getElementById('lang-select');
        if (langSelect) {
            langSelect.value = this.currentLocale;
        }
    }
}

// Create a global instance (kept on window: index.html inline handlers call
// i18n.setLocale(...), which resolves via the global scope)
export const i18n = new I18nManager();
if (typeof window !== 'undefined') {
    window.i18n = i18n;

// Function to easily translate strings in JS
    window.t = (key, variables) => window.i18n.t(key, variables);
}

// Auto-apply on load (browser only — node tests import this module headless)
if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => {
        i18n.applyTranslations();
    });
}
