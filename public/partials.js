// Error handling and debugging utilities
console.log('🚀 Book Store Application Loaded');

// Global error handler
window.addEventListener('error', function(e) {
  console.error('❌ Global Error:', e.error);
  console.error('📄 File:', e.filename);
  console.error('📍 Line:', e.lineno);
  console.error('📍 Column:', e.colno);
});

// Unhandled promise rejection handler
window.addEventListener('unhandledrejection', function(e) {
  console.error('❌ Unhandled Promise Rejection:', e.reason);
});

// DOM ready handler
document.addEventListener('DOMContentLoaded', function() {
  console.log('✅ DOM Loaded Successfully');
  
  // Initialize theme from localStorage
  initializeTheme();
  
  // Check for common issues
  checkForIssues();
});

// Theme initialization and persistence
function initializeTheme() {
  const savedTheme = localStorage.getItem('theme');
  const toggle = document.getElementById("theme-toggle");
  
  if (savedTheme === 'dark') {
    document.body.classList.add("dark-theme");
    if (toggle) {
      toggle.innerHTML = '<i class="fa fa-sun-o"></i> Light Mode';
    }
  } else {
    document.body.classList.remove("dark-theme");
    if (toggle) {
      toggle.innerHTML = '<i class="fa fa-moon-o"></i> Dark Mode';
    }
  }
}

// Function to check for common issues
function checkForIssues() {
  // Check if all required elements exist
  const requiredElements = [
    'main-menu',
    'theme-toggle',
    'toast'
  ];
  
  requiredElements.forEach(id => {
    const element = document.getElementById(id);
    if (!element) {
      console.warn(`⚠️ Missing element with id: ${id}`);
    }
  });
  
  // Check if CSS files are loaded
  const stylesheets = document.styleSheets;
  console.log('📚 Loaded stylesheets:', stylesheets.length);
  
  // Check for broken links
  const links = document.querySelectorAll('a');
  links.forEach(link => {
    if (link.href && link.href.includes('localhost')) {
      console.log('🔗 Internal link:', link.href);
    }
  });
}

// Enhanced toast function with error handling
function showToast(message, type = 'info') {
  try {
    const toast = document.getElementById("toast");
    if (toast) {
      toast.innerText = message;
      toast.className = `toast ${type}`;
      toast.classList.add("show");
      
      setTimeout(() => {
        toast.classList.remove("show");
      }, 3000);
    } else {
      console.warn('⚠️ Toast element not found');
      alert(message); // Fallback
    }
  } catch (error) {
    console.error('❌ Error showing toast:', error);
    alert(message); // Fallback
  }
}

// Enhanced menu toggle with error handling
function toggleMenu() {
  try {
    const menu = document.getElementById("main-menu");
    if (menu) {
      menu.classList.toggle("show");
      console.log('🍔 Menu toggled');
    } else {
      console.warn('⚠️ Menu element not found');
    }
  } catch (error) {
    console.error('❌ Error toggling menu:', error);
  }
}

// Enhanced theme toggle with error handling and persistence
function toggleTheme() {
  try {
    const toggle = document.getElementById("theme-toggle");
    if (toggle) {
      document.body.classList.toggle("dark-theme");
      const isDark = document.body.classList.contains("dark-theme");
      
      // Save theme preference to localStorage
      localStorage.setItem('theme', isDark ? 'dark' : 'light');
      
      toggle.innerHTML = isDark 
        ? '<i class="fa fa-sun-o"></i> Light Mode'
        : '<i class="fa fa-moon-o"></i> Dark Mode';
      console.log('🌙 Theme toggled:', isDark ? 'dark' : 'light');
    } else {
      console.warn('⚠️ Theme toggle element not found');
    }
  } catch (error) {
    console.error('❌ Error toggling theme:', error);
  }
}

// Enhanced dropdown toggle with error handling
function toggleDropdown(event) {
  try {
    event.preventDefault();
    const menu = document.getElementById("dropdown-menu");
    if (menu) {
      menu.classList.toggle("show");
      
      // Close dropdown when clicking outside
      const handleOutsideClick = function(e) {
        const dropdown = document.getElementById("user-dropdown");
        if (dropdown && !dropdown.contains(e.target)) {
          menu.classList.remove("show");
          document.removeEventListener("click", handleOutsideClick);
        }
      };
      
      setTimeout(() => {
        document.addEventListener("click", handleOutsideClick);
      }, 100);
      
      console.log('📋 Dropdown toggled');
    } else {
      console.warn('⚠️ Dropdown menu element not found');
    }
  } catch (error) {
    console.error('❌ Error toggling dropdown:', error);
  }
}

// Form validation helper
function validateForm(formElement) {
  try {
    const inputs = formElement.querySelectorAll('input[required], textarea[required]');
    let isValid = true;
    
    inputs.forEach(input => {
      if (!input.value.trim()) {
        input.classList.add('error');
        isValid = false;
      } else {
        input.classList.remove('error');
      }
    });
    
    return isValid;
  } catch (error) {
    console.error('❌ Error validating form:', error);
    return false;
  }
}

// Export functions for global use
window.showToast = showToast;
window.toggleMenu = toggleMenu;
window.toggleTheme = toggleTheme;
window.toggleDropdown = toggleDropdown;
window.validateForm = validateForm;
window.initializeTheme = initializeTheme;

console.log('✅ Error handling utilities loaded');

document.addEventListener('DOMContentLoaded', function () {
    const searchInput = document.getElementById('searchInput');
    const dropdownList = document.getElementById('dropdownList');

    // Debounce function used to prevent a lot of fetch request per input.
    const debounce = (func, delay) => {
        let timeoutId;
        return (...args) => {
            clearTimeout(timeoutId);
            timeoutId = setTimeout(() => {
                func(...args);
            }, delay);
        };
    };

    // Function to handle the debounced input event
    const handleDebouncedInput = async function () {
        const searchTerm = searchInput.value.trim();
        console.log("Search Term: ", searchTerm);

        try {
            const { bookTitle, bookAuthor, coverId } = await fetchData(searchTerm);            
            
            console.log("Searched Book: ", bookTitle);
            console.log("Cover Id: ", coverId);
            console.log("Book Author: ", bookAuthor);
            // Update the dropdown list
            await updateDropdown(bookTitle, coverId, bookAuthor, dropdownList);
        } catch (error) {
            console.error('Error updating dropdown:', error);
        }
    };

    // Attach the debounced input event handler
    searchInput.addEventListener('input', debounce(handleDebouncedInput, 300));

    document.addEventListener('click', function (event) {
        // Close dropdown when clicking outside the search container
        if (!event.target.closest('.dropdown')) {
            dropdownList.style.display = 'none';
        }
    });
    const label = $("label");
    const labelArray = document.querySelectorAll("label");
    //Add checked (orange color) class clicked labels.    
    label.on("click", function(event) {          
        label.removeClass("checked");        
        const labelValue = $(this).attr("for");
        for (let i = 0; i < labelValue; i++) {            
            $(labelArray[i]).addClass("checked");            
        }       
    })   
    
});

async function fetchData(searchTerm) {
    try {
        const response = await fetch(`https://openlibrary.org/search.json?q=${searchTerm}&limit=10`);
        if (!response.ok) {
            throw new Error(`HTTP error! Status: ${response.status}`);
        }
        const data = await response.json();
        console.log(data);
        const result = data.docs;
        const bookTitle = result.map((book) => book.title);
        const bookAuthor = result.map((book) => book.author_name ? book.author_name[0] : 'Unknown');
        const coverId = result.map((book) => book.cover_i);        

        return {
            bookTitle: bookTitle,
            bookAuthor: bookAuthor,
            coverId: coverId,
        };
    } catch (error) {
        console.error("Error fetching data: ", error);
    }
}

async function updateDropdown(items, coverId, bookAuthor, dropdownList) {
    //create list items based on the fetch results. 
       
    const html = items.map((item, index) =>
        `<a href="/book?title=${item}&author=${bookAuthor[index]}&coverId=${coverId[index]? coverId[index]: 0}">
        <li class="listItem">
        <img src="https://covers.openlibrary.org/b/id/${coverId[index]}-S.jpg?default=https://openlibrary.org/static/images/icons/avatar_book-sm.png" width="40" height="60" alt="book picture">
        <div>
        <p><strong>${item}</strong></p>
        <p>By ${bookAuthor[index]}</p>
        </div>
        </li>
        </a>`).join('');
    dropdownList.innerHTML = html;    

    // Show/hide dropdown
    if (items.length > 0) {
        dropdownList.style.display = 'block';
    } else {
        dropdownList.style.display = 'none';
    }

}
