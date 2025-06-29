import express from "express";
import bodyParser from "body-parser";
import pg from "pg";
import session from "express-session";
import dotenv from "dotenv";
import bcrypt from "bcrypt";
import passport from "passport";
import GoogleStrategy from "passport-google-oauth2";


dotenv.config();


const app = express();
const port = 3000;


app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static("public"));
app.set("view engine", "ejs");


app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false, 
    httpOnly: true, 
    maxAge: 24 * 60 * 60 * 1000 
  }
}));



app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.isAuthenticated = !!req.session.user; 
  res.locals.admin = req.session.admin || null;
  res.locals.error = req.session.error || req.session.adminError || null;
  res.locals.message = req.session.message || req.session.adminMessage || null;
  next();
});


const db = new pg.Client({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

db.connect();

async function cleanupDatabase() {
  try {
    console.log("Starting database cleanup...");
    
    // Clean up corrupted book records (null, empty, or whitespace-only titles/authors)
    const result = await db.query(
      `DELETE FROM books WHERE title IS NULL OR title = '' OR TRIM(title) = '' OR author IS NULL OR author = '' OR TRIM(author) = ''`
    );
    
    if (result.rowCount > 0) {
      console.log(`Cleaned up ${result.rowCount} corrupted book records`);
    }
    
    // Clean up orphaned review records
    const orphanedReviews = await db.query(
      `DELETE FROM book_reviews 
       WHERE book_id NOT IN (SELECT book_id FROM books)`
    );
    
    if (orphanedReviews.rowCount > 0) {
      console.log(`Cleaned up ${orphanedReviews.rowCount} orphaned review records`);
    }
    
    // Clean up orphaned wishlist records
    const orphanedWishlist = await db.query(
      `DELETE FROM wishlist 
       WHERE book_id NOT IN (SELECT book_id FROM books)`
    );
    
    if (orphanedWishlist.rowCount > 0) {
      console.log(`Cleaned up ${orphanedWishlist.rowCount} orphaned wishlist records`);
    }
    
    // Clean up orphaned notification records
    const orphanedNotifications = await db.query(
      `DELETE FROM notifications 
       WHERE related_id IS NOT NULL AND related_type = 'book' 
       AND related_id NOT IN (SELECT book_id FROM books)`
    );
    
    if (orphanedNotifications.rowCount > 0) {
      console.log(`Cleaned up ${orphanedNotifications.rowCount} orphaned notification records`);
    }
    
    console.log("Database cleanup completed");
  } catch (error) {
    console.error('Database cleanup error:', error.message);
  }
}



db.on('connect', () => {
  console.log('Database connected successfully');
  cleanupDatabase();
});

db.on('error', (err) => {
  console.error('Database connection error:', err);
});



app.use(passport.initialize());
app.use(passport.session());



passport.use(
  new GoogleStrategy({
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: "http://localhost:3000/auth/google/callback",
      passReqToCallback: true,
    },
    async (request, accessToken, refreshToken, profile, done) => {
      const email = profile.email;
      const name = profile.displayName;

      try {

        let result = await db.query(`SELECT * FROM users WHERE email = $1`, [email]);

        if (result.rows.length === 0) {

          const newUser = await db.query(
            `INSERT INTO users (name, email, phone_number, password)
             VALUES ($1, $2, '', '')
             RETURNING *`,
            [name, email]
          );
          return done(null, newUser.rows[0]);
        }


        return done(null, result.rows[0]);
      } catch (err) {
        console.error('Google auth error:', err);
        return done(err, null);
      }
    }
  )
);


passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
  try {

  const result = await db.query(`SELECT * FROM users WHERE id = $1`, [id]);
  done(null, result.rows[0]);
  } catch (err) {
    done(err, null);
  }
});


app.get("/auth/google",
  passport.authenticate("google", { scope: ["email", "profile"] })
);

app.get("/auth/google/callback",
  passport.authenticate("google", {
    failureRedirect: "/login",
  }),
  (req, res) => {
    req.session.user = req.user;
    res.redirect("/home");
  }
);

app.get("/", (req, res) => {
  res.render("home.ejs");
});

// Registration page - where new users can create an account
app.get("/account", (req, res) => {
  res.render("register.ejs");
});

// Login page - where existing users can sign in
app.get("/login", (req, res) => {
  const message = req.session.message;
  const error = req.session.error;
  req.session.message = null; // Clear the message after showing it
  req.session.error = null; // Clear the error after showing it
  res.render("signIn.ejs", { message, error });
});

// Handle user registration - when someone fills out the sign-up form
app.post("/", async (req, res) => {
  const { name, email, phone, password } = req.body;
  
  console.log("Registration attempt:", { name, email, phone, passwordLength: password?.length });
  
  if (!name || !email || !phone || !password) {
    console.log("Registration failed: Missing required fields");
    req.session.error = "All fields are required.";
    return res.redirect("/account");
  }
  
  try {
    const existingUser = await db.query(`SELECT * FROM users WHERE email = $1`, [email]);
    if (existingUser.rows.length > 0) {
      console.log("Registration failed: Email already exists:", email);
      req.session.error = "Email already registered. Please sign in.";
      return res.redirect("/login");
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    console.log("Password hashed successfully");

    await db.query("BEGIN");
    const newUser = await db.query(
      `INSERT INTO users (name, email, phone_number, password)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [name, email, phone, hashedPassword]
    );
    await db.query("COMMIT");

    await createNotification(
      newUser.rows[0].id,
      'system',
      'Welcome to Book Notes!',
      `Welcome ${name}! Start your reading journey by adding your first book. Click "Add Books" in the navigation to get started.`,
      null,
      'welcome'
    );

    console.log("User registered successfully:", { 
      id: newUser.rows[0].id, 
      name: newUser.rows[0].name, 
      email: newUser.rows[0].email 
    });
    req.session.message = "Registered successfully! Please sign in.";
    res.redirect("/login");
  } catch (error) {
    await db.query("ROLLBACK");
    console.error("Registration error:", error);
    req.session.error = "Registration failed. Please try again.";
    res.redirect("/account");
  }
});

// Handle user login - when someone tries to sign in
app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  
  console.log("Login attempt:", { email, passwordLength: password?.length });
  
  if (!email || !password) {
    console.log("Login failed: Missing email or password");
    req.session.error = "Email and password are required.";
    return res.redirect("/login");
  }
  
  try {
    const result = await db.query(`SELECT * FROM users WHERE email = $1`, [email]);
    console.log("Database query result:", { found: result.rows.length > 0 });

    if (result.rows.length > 0) {
      const user = result.rows[0];
      console.log("User found:", { id: user.id, name: user.name, email: user.email });
      
      const match = await bcrypt.compare(password, user.password);
      console.log("Password match:", match);

      if (match) {
        req.session.user = user;
        console.log("Login successful, redirecting to home");
        return res.redirect("/home");
      } else {
        console.log("Login failed: Password mismatch");
      }
    } else {
      console.log("Login failed: User not found");
    }

    req.session.error = "Invalid email or password";
    res.redirect("/login");

  } catch (err) {
    console.error("Login error:", err);
    req.session.error = "Internal server error";
    res.redirect("/login");
  }
});

// Password reset page - for users who forgot their password
app.get("/forget-password", (req, res) => {
  res.render("forgetPassword.ejs", { message: null, error: null });
});

// Handle password reset - when someone submits the reset form
app.post("/forget-password", async (req, res) => {
  const { email, newPassword } = req.body;

  try {
    const result = await db.query(`SELECT * FROM users WHERE email = $1`, [email]);
    if (result.rows.length === 0) {
      return res.render("forgetPassword.ejs", {
        error: "Email not found.",
        message: null,
      });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await db.query(`UPDATE users SET password = $1 WHERE email = $2`, [
      hashedPassword,
      email,
    ]);

    res.render("signIn.ejs", {
      error: null,
      message: "Password updated successfully! Please sign in.",
    });
  } catch (err) {
    console.error("Forget Password error:", err);
    res.render("forgetPassword.ejs", {
      error: "Server error. Please try again.",
      message: null,
    });
  }
});


// Home page - accessible to everyone (both logged-in and non-logged-in users)
app.get("/home", (req, res) => {
  res.render("home.ejs");
});

// Search route - handles the search form submission from the navigation
app.get("/search", (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  
  const { search } = req.query;
  if (!search || search.trim().length < 3) {
    return res.redirect("/book");
  }
  
  res.redirect(`/book?search=${encodeURIComponent(search.trim())}`);
});

// Book page - handles both adding new books and editing existing ones
app.get("/book", async (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  const { title, author, coverId, search } = req.query;
  
  if (search) {
    return res.render("addBook.ejs", { search });
  }
  
  if (title && author) {
  try {
    const response = await db.query(
        `SELECT b.*, br.rating, br.review_text, br.review_date
         FROM books b
         LEFT JOIN book_reviews br ON b.book_id = br.book_id
         WHERE b.id = $1 AND b.title IS NOT NULL AND b.title != '' AND b.author IS NOT NULL AND b.author != ''`,
      [req.session.user.id]
    );
    const data = response.rows;
    const existingBook = data.find((book) => book.title === title);
    res.render("addBook.ejs", {
      title,
      author,
      cover: coverId,
      review: existingBook?.review_text,
      book_id: existingBook?.book_id,
    });
  } catch (error) {
      console.error("Book route error:", error.message);
      res.render("addBook.ejs", { title, author, cover: coverId });
    }
  } else {
    res.render("addBook.ejs", {});
  }
});

// Update an existing book review
app.post("/updateReview", async (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  
  const { review_text, rating, bookId } = req.body;
  const currentDate = new Date().toISOString();
  
  try {
    await db.query(
      `UPDATE book_reviews
       SET review_text = $1, rating = $2, review_date = $3
       WHERE book_id = $4 AND id = $5`,
      [review_text, rating, currentDate, bookId, req.session.user.id]
    );
    res.redirect("/myBooks");
  } catch (error) {
    console.error("Error updating review:", error.message);
    res.redirect("/myBooks");
  }
});

// Add a new book to the user's collection
app.post("/addBook", async (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  
  const { title, author, cover_id, review_text, rating } = req.body;
  
  if (!title || !title.trim()) {
    console.log("Add book failed: Title is required");
    return res.send("Title is required.");
  }
  
  if (!author || !author.trim()) {
    console.log("Add book failed: Author is required");
    return res.send("Author is required.");
  }
  
  if (!rating || rating < 1 || rating > 5) {
    console.log("Add book failed: Valid rating (1-5) is required");
    return res.send("Valid rating (1-5) is required.");
  }
  
  console.log("Adding book:", { title: title.trim(), author: author.trim(), rating, userId: req.session.user.id });
  
  try {
    await db.query("BEGIN");

    const newBook = await db.query(
      `INSERT INTO books (title, author, cover_id, id)
       VALUES ($1, $2, $3, $4)
       RETURNING book_id`,
      [title.trim(), author.trim(), cover_id || null, req.session.user.id]
    );

    await db.query(
      `INSERT INTO book_reviews (book_id, id, review_text, rating)
       VALUES ($1, $2, $3, $4)`,
      [newBook.rows[0].book_id, req.session.user.id, review_text || '', rating]
    );

    await createNotification(
      req.session.user.id,
      'books',
      'New Book Added',
      `You successfully added "${title.trim()}" to your collection with a ${rating}/5 rating.`,
      newBook.rows[0].book_id,
      'book'
    );

    await db.query("COMMIT");
    console.log("Book added successfully:", { bookId: newBook.rows[0].book_id, title: title.trim() });
    res.redirect("/myBooks");
  } catch (error) {
    await db.query("ROLLBACK");
    console.error("Add book error:", error.message);
    res.redirect("/book");
  }
});

// Delete a book from the user's collection
app.delete("/delete/:id", async (req, res) => {
  if (!req.session.user) return res.status(401).send("Unauthorized");
  
  const bookId = req.params.id;
  try {
    await db.query("BEGIN");

    const check = await db.query(
      `SELECT * FROM books WHERE book_id = $1 AND id = $2`,
      [bookId, req.session.user.id]
    );

    if (check.rows.length === 0) {
      return res.status(403).send("Unauthorized");
    }

    await db.query(`DELETE FROM book_reviews WHERE book_id = $1`, [bookId]);
    await db.query(`DELETE FROM books WHERE book_id = $1`, [bookId]);

    await db.query("COMMIT");
    res.sendStatus(200);
  } catch (error) {
    await db.query("ROLLBACK");
    console.error("An error occurred:", error);
    res.sendStatus(500);
  }
});

// Contact page - where users can send us messages
app.get("/contact", (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  res.render("contact.ejs");
});

// Handle contact form submissions - when someone sends us a message
app.post("/contact", (req, res) => {
  const { name, email, message } = req.body;
  console.log(`New message from ${name} (${email}): ${message}`);
  
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <meta http-equiv="refresh" content="3;url=/home" />
        <style>
          body { font-family: Arial; background: #f3f3f3; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
          .thank-you-box { background: white; padding: 30px; border-radius: 10px; box-shadow: 0 8px 20px rgba(0,0,0,0.1); text-align: center; }
        </style>
      </head>
      <body>
        <div class="thank-you-box">
          <h2>Thank you, ${name}!</h2>
          <p>Your message has been received.</p>
          <p>You'll be redirected shortly.</p>
        </div>
      </body>
    </html>
  `);
});

// Logout - clear the user's session and send them back to login
app.get("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) console.log("Logout Error:", err);
    res.redirect("/login");
  });
});

// My Books page - shows all the books in the user's collection
app.get("/myBooks", async (req, res) => {
  if (!req.session.user) return res.redirect("/login");

  try {
    const result = await db.query(
      `SELECT b.*, br.rating, br.review_text, br.review_date,
              CASE WHEN w.book_id IS NOT NULL THEN true ELSE false END as in_wishlist
       FROM books b
       JOIN book_reviews br ON b.book_id = br.book_id
       LEFT JOIN wishlist w ON b.book_id = w.book_id AND w.user_id = $1
       WHERE b.id = $1
       ORDER BY br.review_date DESC`,
      [req.session.user.id]
    );

    if (result.rows.length === 0) {
      const existingNotification = await db.query(
        `SELECT * FROM notifications 
         WHERE user_id = $1 AND type = 'system' AND related_type = 'first_visit'`,
        [req.session.user.id]
      );
      
      if (existingNotification.rows.length === 0) {
        await createNotification(
          req.session.user.id,
          'system',
          'Get Started with Book Notes',
          'Ready to start your reading journey? Click "Add Books" in the navigation to search and add your first book to your collection!',
          null,
          'first_visit'
        );
      }
    }

    res.render("myBooks.ejs", { books: result.rows });

  } catch (err) {
    console.error("Error fetching books for user:", err.message);
    res.render("myBooks.ejs", { books: [] });
  }
});

// Wishlist page - shows all the books the user wants to read later
app.get('/wishlist', async (req, res) => {
  if (!req.session.user) return res.redirect("/login");

  try {
    const result = await db.query(
      `SELECT b.*
       FROM wishlist w
       JOIN books b ON w.book_id = b.book_id
       WHERE w.user_id = $1`,
      [req.session.user.id]
    );

    res.render('wishlist.ejs', { books: result.rows });
  } catch (err) {
    console.error('Error loading wishlist:', err.message);
    res.render('wishlist.ejs', { books: [] });
  }
});

// Add a book to the user's wishlist
app.post("/wishlist/add", async (req, res) => {
  if (!req.session.user) {
    console.log("Wishlist add: User not authenticated");
    return res.json({ success: false, message: "You must be logged in to add to wishlist." });
  }
  
  const bookId = req.body.bookId;
  if (!bookId) {
    console.log("Wishlist add: Book ID missing");
    return res.json({ success: false, message: "Book ID is missing." });
  }

  console.log(`Wishlist add: User ${req.session.user.id} trying to add book ${bookId}`);

  try {
    await db.query("BEGIN");

    const checkDuplicateSql = `SELECT * FROM wishlist WHERE user_id = $1 AND book_id = $2`;
    const duplicateCheckResult = await db.query(checkDuplicateSql, [req.session.user.id, bookId]);

    if (duplicateCheckResult.rows.length > 0) {
      await db.query("ROLLBACK"); 
      console.log("Wishlist add: Book already in wishlist");
      return res.json({ success: false, message: "This book is already in your wishlist." });
    } else {
      const insertSql = `INSERT INTO wishlist (user_id, book_id, added_at) VALUES ($1, $2, CURRENT_TIMESTAMP) RETURNING *`;
      const newWishlistItem = await db.query(insertSql, [req.session.user.id, bookId]);

      const bookResult = await db.query(`SELECT title FROM books WHERE book_id = $1`, [bookId]);
      const bookTitle = bookResult.rows[0]?.title || 'a book';

      await createNotification(
        req.session.user.id,
        'wishlist',
        'Wishlist Update',
        `"${bookTitle}" has been added to your wishlist for future reading.`,
        bookId,
        'wishlist'
      );

      await db.query("COMMIT");
      console.log("Wishlist add: Successfully added book to wishlist");
      return res.json({ success: true, message: "Book added to your wishlist!" });
    }
  } catch (error) {
    await db.query("ROLLBACK");
    console.error("Wishlist add error:", error);
    return res.json({ success: false, message: "Failed to add book to wishlist." });
  }
});

// Remove a book from the user's wishlist
app.post('/wishlist/remove', async (req, res) => {
  if (!req.session.user) {
    console.log("Wishlist remove: User not authenticated");
    return res.json({ success: false, message: "Not authenticated" });
  }
  
  const { bookId } = req.body;
  console.log(`Wishlist remove: User ${req.session.user.id} trying to remove book ${bookId}`);

  try {
    const result = await db.query(
      'DELETE FROM wishlist WHERE user_id = $1 AND book_id = $2',
      [req.session.user.id, bookId]
    );
    
    console.log(`Wishlist remove: Deleted ${result.rowCount} rows`);
    res.json({ success: true, message: "Book removed from wishlist!" });
  } catch (err) {
    console.error('Error removing from wishlist:', err);
    res.json({ success: false, message: "Failed to remove book from wishlist." });
  }
});

// User profile page - where users can see their account information
app.get("/profile", (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  res.render("profile.ejs", { user: req.session.user });
});

// Settings page - where users can change their account settings
app.get("/settings", (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  res.render("settings.ejs", { user: req.session.user });
});

// Update user profile information
app.post("/update-profile", async (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  
  const { name, email, phone } = req.body;
  
  try {
    await db.query(
      `UPDATE users SET name = $1, email = $2, phone_number = $3 WHERE id = $4`,
      [name, email, phone, req.session.user.id]
    );
    
    req.session.user = { ...req.session.user, name, email, phone_number: phone };
    
    req.session.message = "Profile updated successfully!";
    res.redirect("/profile");
  } catch (error) {
    console.error("Profile update error:", error);
    req.session.error = "Failed to update profile. Please try again.";
    res.redirect("/settings");
  }
});

// Change user password
app.post("/change-password", async (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  
  const { currentPassword, newPassword, confirmPassword } = req.body;
  
  if (newPassword !== confirmPassword) {
    req.session.error = "New passwords do not match.";
    return res.redirect("/settings");
  }
  
  try {
    const user = await db.query(`SELECT * FROM users WHERE id = $1`, [req.session.user.id]);
    const match = await bcrypt.compare(currentPassword, user.rows[0].password);
    
    if (!match) {
      req.session.error = "Current password is incorrect.";
      return res.redirect("/settings");
    }
    
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    
    await db.query(`UPDATE users SET password = $1 WHERE id = $2`, [hashedPassword, req.session.user.id]);
    
    req.session.message = "Password changed successfully!";
    res.redirect("/settings");
  } catch (error) {
    console.error("Password change error:", error);
    req.session.error = "Failed to change password. Please try again.";
    res.redirect("/settings");
  }
});

// Helper function to create notifications
async function createNotification(userId, type, title, message, relatedId = null, relatedType = null) {
  try {
    await db.query(
      `INSERT INTO notifications (user_id, type, title, message, related_id, related_type)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, type, title, message, relatedId, relatedType]
    );
  } catch (error) {
    console.error('Error creating notification:', error);
  }
}

// Helper function to format time ago
function formatTimeAgo(date) {
  const now = new Date();
  const diffInSeconds = Math.floor((now - date) / 1000);
  
  if (diffInSeconds < 60) return 'Just now';
  if (diffInSeconds < 3600) return `${Math.floor(diffInSeconds / 60)} minutes ago`;
  if (diffInSeconds < 86400) return `${Math.floor(diffInSeconds / 3600)} hours ago`;
  if (diffInSeconds < 2592000) return `${Math.floor(diffInSeconds / 86400)} days ago`;
  if (diffInSeconds < 31536000) return `${Math.floor(diffInSeconds / 2592000)} months ago`;
  return `${Math.floor(diffInSeconds / 31536000)} years ago`;
}

// Notifications page
app.get("/notifications", async (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  
  try {
    const result = await db.query(
      `SELECT * FROM notifications 
       WHERE user_id = $1 
       ORDER BY created_at DESC 
       LIMIT 50`,
      [req.session.user.id]
    );
    
    const notifications = result.rows.map(notification => ({
      ...notification,
      timeAgo: formatTimeAgo(new Date(notification.created_at))
    }));
    
    const getIconForType = (type) => {
      switch(type) {
        case 'books': return 'book';
        case 'wishlist': return 'heart';
        case 'system': return 'cog';
        default: return 'bell';
      }
    };
    
    res.render("notifications.ejs", { notifications, getIconForType });
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.render("notifications.ejs", { notifications: [], getIconForType: () => 'bell' });
  }
});

app.post("/notifications/mark-read", async (req, res) => {
  if (!req.session.user) {
    return res.json({ success: false, message: "Not authenticated" });
  }
  
  const { notificationId } = req.body;
  
  try {
    await db.query(
      `UPDATE notifications SET is_read = true 
       WHERE notification_id = $1 AND user_id = $2`,
      [notificationId, req.session.user.id]
    );
    
    res.json({ success: true, message: "Notification marked as read" });
  } catch (error) {
    console.error('Error marking notification as read:', error);
    res.json({ success: false, message: "Failed to mark notification as read" });
  }
});

app.post("/notifications/mark-all-read", async (req, res) => {
  if (!req.session.user) {
    return res.json({ success: false, message: "Not authenticated" });
  }
  
  try {
    await db.query(
      `UPDATE notifications SET is_read = true 
       WHERE user_id = $1`,
      [req.session.user.id]
    );
    
    res.json({ success: true, message: "All notifications marked as read" });
  } catch (error) {
    console.error('Error marking all notifications as read:', error);
    res.json({ success: false, message: "Failed to mark notifications as read" });
  }
});

app.post("/notifications/clear-all", async (req, res) => {
  if (!req.session.user) {
    return res.json({ success: false, message: "Not authenticated" });
  }
  
  try {
    await db.query(
      `DELETE FROM notifications WHERE user_id = $1`,
      [req.session.user.id]
    );
    
    res.json({ success: true, message: "All notifications cleared" });
  } catch (error) {
    console.error('Error clearing notifications:', error);
    res.json({ success: false, message: "Failed to clear notifications" });
  }
});

app.post("/editBook", async (req, res) => {
  if (!req.session.user) {
    return res.json({ success: false, message: "Not authenticated" });
  }
  
  const { bookId, rating, review } = req.body;
  
  console.log("Edit book request:", { bookId, rating, review, userId: req.session.user.id });
  
  try {
    const bookResult = await db.query(`SELECT title FROM books WHERE book_id = $1`, [bookId]);
    const bookTitle = bookResult.rows[0]?.title || 'a book';

    const updateResult = await db.query(
      `UPDATE book_reviews 
       SET rating = $1, review_text = $2, review_date = CURRENT_TIMESTAMP
       WHERE book_id = $3 AND id = $4`,
      [rating, review, bookId, req.session.user.id]
    );

    console.log("Update result:", updateResult.rowCount, "rows affected");

    if (updateResult.rowCount === 0) {
      return res.json({ success: false, message: "Book review not found or you don't have permission to edit it" });
    }

    await createNotification(
      req.session.user.id,
      'books',
      'Review Updated',
      `Your review for "${bookTitle}" has been updated with a ${rating}/5 rating.`,
      bookId,
      'review'
    );
    
    res.json({ success: true, message: "Book review updated successfully!" });
  } catch (error) {
    console.error("Edit book error:", error);
    res.json({ success: false, message: "Failed to update book review" });
  }
});

app.post("/deleteBook", async (req, res) => {
  if (!req.session.user) {
    return res.json({ success: false, message: "Not authenticated" });
  }
  
  const { bookId } = req.body;
  
  try {
    await db.query("BEGIN");
    
    await db.query(
      `DELETE FROM book_reviews WHERE book_id = $1 AND id = $2`,
      [bookId, req.session.user.id]
    );
    
    await db.query(
      `DELETE FROM books WHERE book_id = $1 AND id = $2`,
      [bookId, req.session.user.id]
    );
    
    await db.query(
      `DELETE FROM wishlist WHERE book_id = $1 AND user_id = $2`,
      [bookId, req.session.user.id]
    );
    
    await db.query("COMMIT");
    
    res.json({ success: true, message: "Book deleted successfully!" });
  } catch (error) {
    await db.query("ROLLBACK");
    console.error("Delete book error:", error.message);
    res.sendStatus(500);
  }
});

app.get("/search-api", async (req, res) => {
  const query = req.query.query;
  
  if (!query || query.length < 3) {
    return res.json([]);
  }
  
  try {
    const response = await fetch(
      `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=10`
    );
    const data = await response.json();
    
    const books = data.docs.map(book => ({
      title: book.title || 'Unknown Title',
      author: book.author_name ? book.author_name[0] : 'Unknown Author',
      cover_id: book.cover_i || 0
    }));
    
    res.json(books);
  } catch (error) {
    console.error('Search API error:', error);
    res.json([]);
  }
});

// Manual database cleanup route (for fixing corrupted data)
app.get("/cleanup-db", async (req, res) => {
  try {
    console.log("Manual database cleanup started...");
    
    const result = await db.query(
      `DELETE FROM books WHERE title IS NULL OR title = '' OR author IS NULL OR author = ''`
    );
    
    const orphanedReviews = await db.query(
      `DELETE FROM book_reviews 
       WHERE book_id NOT IN (SELECT book_id FROM books)`
    );
    
    const orphanedWishlist = await db.query(
      `DELETE FROM wishlist 
       WHERE book_id NOT IN (SELECT book_id FROM books)`
    );
    
    const orphanedNotifications = await db.query(
      `DELETE FROM notifications 
       WHERE related_id IS NOT NULL AND related_type = 'book' 
       AND related_id NOT IN (SELECT book_id FROM books)`
    );
    
    console.log(`Manual cleanup completed: ${result.rowCount} books, ${orphanedReviews.rowCount} reviews, ${orphanedWishlist.rowCount} wishlist items, ${orphanedNotifications.rowCount} notification items`);
    
    res.json({ 
      success: true, 
      message: `Database cleaned: ${result.rowCount} books, ${orphanedReviews.rowCount} reviews, ${orphanedWishlist.rowCount} wishlist items, ${orphanedNotifications.rowCount} notification items removed` 
    });
  } catch (error) {
    console.error('Manual cleanup error:', error);
    res.json({ success: false, message: "Cleanup failed" });
  }
});

app.get("/admin", (req, res) => {
  const message = req.session.adminMessage;
  const error = req.session.adminError;
  req.session.adminMessage = null;
  req.session.adminError = null;
  res.render("admin.ejs", { message, error });
});

app.post("/admin/login", async (req, res) => {
  const { username, password } = req.body;
  
  console.log("Admin login attempt:", { username, passwordLength: password?.length });
  
  if (!username || !password) {
    console.log("Admin login failed: Missing credentials");
    req.session.adminError = "Username and password are required.";
    return res.redirect("/login");
  }
  
  try {
    // Authenticate against database (do not create table)
    const result = await db.query(`SELECT * FROM admins WHERE username = $1`, [username]);
    
    if (result.rows.length > 0) {
      const admin = result.rows[0];
      const match = await bcrypt.compare(password, admin.password);
      
      if (match) {
        req.session.admin = { 
          id: admin.id,
          username: admin.username, 
          name: admin.name,
          email: admin.email,
          isAdmin: true 
        };
        console.log("Admin login successful:", username);
        res.redirect("/admin/dashboard");
      } else {
        console.log("Admin login failed: Password mismatch");
        req.session.adminError = "Invalid admin credentials.";
        res.redirect("/login");
      }
    } else {
      // Fallback to hardcoded admin for development
      const adminUsername = process.env.ADMIN_USERNAME || "admin";
      const adminPassword = process.env.ADMIN_PASSWORD || "admin123";
      
      if (username === adminUsername && password === adminPassword) {
        req.session.admin = { 
          username, 
          name: "Default Admin",
          isAdmin: true 
        };
        console.log("Admin login successful (fallback):", username);
        res.redirect("/admin/dashboard");
      } else {
        console.log("Admin login failed: Invalid credentials");
        req.session.adminError = "Invalid admin credentials.";
        res.redirect("/login");
      }
    }
  } catch (error) {
    console.error("Admin login error:", error);
    req.session.adminError = "Admin login failed. Please try again.";
    res.redirect("/login");
  }
});

app.get("/admin/dashboard", (req, res) => {
  if (!req.session.admin || !req.session.admin.isAdmin) {
    return res.redirect("/admin");
  }
  
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Admin Dashboard - Book Notes</title>
        <style>
          body { 
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            margin: 0; 
            padding: 20px; 
            color: #ecf0f1;
            min-height: 100vh;
          }
          .dashboard { 
            max-width: 1200px; 
            margin: 0 auto; 
            background: rgba(255, 255, 255, 0.05);
            padding: 30px; 
            border-radius: 15px; 
            box-shadow: 0 10px 30px rgba(0,0,0,0.3);
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255, 255, 255, 0.1);
          }
          .header { 
            display: flex; 
            justify-content: space-between; 
            align-items: center; 
            margin-bottom: 30px; 
            padding-bottom: 20px; 
            border-bottom: 2px solid rgba(255, 255, 255, 0.1);
          }
          .header h1 {
            color: #f39c12;
            margin: 0;
            font-size: 2.5rem;
            font-weight: 700;
          }
          .stats { 
            display: grid; 
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); 
            gap: 20px; 
            margin-bottom: 30px; 
          }
          .stat-card { 
            background: linear-gradient(135deg, #2c3e50, #34495e); 
            color: white; 
            padding: 25px; 
            border-radius: 15px; 
            text-align: center;
            border: 1px solid rgba(255, 255, 255, 0.1);
            transition: transform 0.3s ease;
          }
          .stat-card:hover {
            transform: translateY(-5px);
          }
          .stat-number { 
            font-size: 2.5em; 
            font-weight: bold; 
            margin-bottom: 10px;
            color: #f39c12;
          }
          .actions { 
            display: flex; 
            gap: 15px; 
            flex-wrap: wrap;
          }
          .btn { 
            padding: 12px 24px; 
            border: none; 
            border-radius: 8px; 
            cursor: pointer; 
            text-decoration: none; 
            display: inline-block;
            font-weight: 600;
            transition: all 0.3s ease;
            text-transform: uppercase;
            letter-spacing: 1px;
          }
          .btn-primary { 
            background: linear-gradient(135deg, #3498db, #2980b9); 
            color: white; 
          }
          .btn-primary:hover {
            background: linear-gradient(135deg, #2980b9, #1f5f8b);
            transform: translateY(-2px);
            box-shadow: 0 8px 25px rgba(52, 152, 219, 0.3);
          }
          .btn-danger { 
            background: linear-gradient(135deg, #e74c3c, #c0392b); 
            color: white; 
          }
          .btn-danger:hover {
            background: linear-gradient(135deg, #c0392b, #a93226);
            transform: translateY(-2px);
            box-shadow: 0 8px 25px rgba(231, 76, 60, 0.3);
          }
          .btn-success {
            background: linear-gradient(135deg, #27ae60, #2ecc71);
            color: white;
          }
          .btn-success:hover {
            background: linear-gradient(135deg, #2ecc71, #27ae60);
            transform: translateY(-2px);
            box-shadow: 0 8px 25px rgba(39, 174, 96, 0.3);
          }
          .section-title {
            color: #f39c12;
            font-size: 1.8rem;
            margin-bottom: 20px;
            font-weight: 600;
          }
          .admin-info {
            background: rgba(255, 255, 255, 0.05);
            padding: 20px;
            border-radius: 10px;
            margin-bottom: 30px;
            border: 1px solid rgba(255, 255, 255, 0.1);
          }
          .admin-info h3 {
            color: #f39c12;
            margin: 0 0 10px 0;
          }
          .admin-info p {
            margin: 5px 0;
            color: #bdc3c7;
          }
        </style>
      </head>
      <body>
        <div class="dashboard">
          <div class="header">
            <h1>Admin Dashboard</h1>
            <div class="actions">
              <a href="/admin/users" class="btn btn-primary">Manage Users</a>
              <a href="/admin/books" class="btn btn-primary">Manage Books</a>
              <a href="/admin/logs" class="btn btn-success">View Logs</a>
              <a href="/admin/logout" class="btn btn-danger">Logout</a>
            </div>
          </div>
          
          <div class="admin-info">
            <h3>Welcome, ${req.session.admin.name || req.session.admin.username}!</h3>
            <p><strong>Role:</strong> Administrator</p>
            <p><strong>Email:</strong> ${req.session.admin.email || 'N/A'}</p>
            <p><strong>Last Login:</strong> ${new Date().toLocaleString()}</p>
          </div>
          
          <div class="stats">
            <div class="stat-card">
              <div class="stat-number" id="userCount">-</div>
              <div>Total Users</div>
            </div>
            <div class="stat-card">
              <div class="stat-number" id="bookCount">-</div>
              <div>Total Books</div>
            </div>
            <div class="stat-card">
              <div class="stat-number" id="reviewCount">-</div>
              <div>Total Reviews</div>
            </div>
            <div class="stat-card">
              <div class="stat-number" id="wishlistCount">-</div>
              <div>Wishlist Items</div>
            </div>
          </div>
          
          <h2 class="section-title">Quick Actions</h2>
          <div class="actions">
            <a href="/cleanup-db" class="btn btn-success" onclick="return confirm('Are you sure you want to clean the database? This will remove corrupted records.')">Clean Database</a>
            <a href="/admin/notifications" class="btn btn-primary">View Notifications</a>
          </div>
        </div>

        <script>
          // Load dashboard stats
          async function loadStats() {
            try {
              const response = await fetch('/admin/stats');
              const stats = await response.json();
              
              document.getElementById('userCount').textContent = stats.users || 0;
              document.getElementById('bookCount').textContent = stats.books || 0;
              document.getElementById('reviewCount').textContent = stats.reviews || 0;
              document.getElementById('wishlistCount').textContent = stats.wishlist || 0;
            } catch (error) {
              console.error('Error loading stats:', error);
            }
          }
          
          // Load stats on page load
          loadStats();
          
          // Refresh stats every 30 seconds
          setInterval(loadStats, 30000);
        </script>
      </body>
    </html>
  `);
});

app.get("/admin/logout", (req, res) => {
  req.session.admin = null;
  res.redirect("/admin");
});

app.post("/admin/register", async (req, res) => {
  const { name, email, username, password, confirmPassword, adminCode } = req.body;
  
  console.log("Admin registration attempt:", { name, email, username, passwordLength: password?.length });
  
  if (!name || !email || !username || !password || !confirmPassword || !adminCode) {
    console.log("Admin registration failed: Missing required fields");
    req.session.adminError = "All fields are required.";
    return res.redirect("/account");
  }
  
  if (password !== confirmPassword) {
    console.log("Admin registration failed: Passwords do not match");
    req.session.adminError = "Passwords do not match.";
    return res.redirect("/account");
  }
  
  if (password.length < 6) {
    console.log("Admin registration failed: Password too short");
    req.session.adminError = "Password must be at least 6 characters long.";
    return res.redirect("/account");
  }
  
  // Verify admin code (you can set this in environment variables)
  const validAdminCode = process.env.ADMIN_REGISTRATION_CODE || "BOOKSADMIN2024";
  if (adminCode !== validAdminCode) {
    console.log("Admin registration failed: Invalid admin code");
    req.session.adminError = "Invalid admin registration code.";
    return res.redirect("/account");
  }
  
  try {
    // Check if email already exists
    const existingUser = await db.query(`SELECT * FROM users WHERE email = $1`, [email]);
    if (existingUser.rows.length > 0) {
      console.log("Admin registration failed: Email already exists:", email);
      req.session.adminError = "Email already registered. Please sign in.";
      return res.redirect("/login");
    }
    
    // Check if username already exists
    const existingAdmin = await db.query(`SELECT * FROM admins WHERE username = $1`, [username]);
    if (existingAdmin.rows.length > 0) {
      console.log("Admin registration failed: Username already exists:", username);
      req.session.adminError = "Admin username already exists.";
      return res.redirect("/account");
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    console.log("Admin password hashed successfully");

    await db.query("BEGIN");
    
    // Create admin record (assume table exists)
    const newAdmin = await db.query(
      `INSERT INTO admins (name, email, username, password, created_at)
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
       RETURNING *`,
      [name, email, username, hashedPassword]
    );
    
    await db.query("COMMIT");

    console.log("Admin registered successfully:", { 
      id: newAdmin.rows[0].id, 
      name: newAdmin.rows[0].name, 
      username: newAdmin.rows[0].username 
    });
    
    req.session.adminMessage = "Admin account created successfully! Please sign in.";
    res.redirect("/login");
  } catch (error) {
    await db.query("ROLLBACK");
    console.error("Admin registration error:", error);
    req.session.adminError = "Admin registration failed. Please try again.";
    res.redirect("/account");
  }
});

// Admin stats route
app.get("/admin/stats", async (req, res) => {
  if (!req.session.admin || !req.session.admin.isAdmin) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  
  try {
    const userCount = await db.query(`SELECT COUNT(*) FROM users`);
    const bookCount = await db.query(`SELECT COUNT(*) FROM books`);
    const reviewCount = await db.query(`SELECT COUNT(*) FROM book_reviews`);
    const wishlistCount = await db.query(`SELECT COUNT(*) FROM wishlist`);
    
    res.json({
      users: parseInt(userCount.rows[0].count),
      books: parseInt(bookCount.rows[0].count),
      reviews: parseInt(reviewCount.rows[0].count),
      wishlist: parseInt(wishlistCount.rows[0].count)
    });
  } catch (error) {
    console.error("Admin stats error:", error.message);
    res.json({ users: 0, books: 0, reviews: 0, wishlist: 0 });
  }
});

// Manage Users page
app.get("/admin/users", async (req, res) => {
  if (!req.session.admin || !req.session.admin.isAdmin) {
    return res.redirect("/admin");
  }
  
  try {
    const users = await db.query(`
      SELECT u.*, 
             COUNT(DISTINCT b.book_id) as book_count,
             COUNT(DISTINCT w.book_id) as wishlist_count
      FROM users u
      LEFT JOIN books b ON u.id = b.id
      LEFT JOIN wishlist w ON u.id = w.user_id
      GROUP BY u.id
      ORDER BY u.id DESC
    `);
    
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Manage Users - Admin</title>
          <style>
            body { 
              font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
              background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
              margin: 0; 
              padding: 20px; 
              color: #ecf0f1;
              min-height: 100vh;
            }
            .container { 
              max-width: 1200px; 
              margin: 0 auto; 
              background: rgba(255, 255, 255, 0.05);
              padding: 30px; 
              border-radius: 15px; 
              box-shadow: 0 10px 30px rgba(0,0,0,0.3);
              backdrop-filter: blur(10px);
              border: 1px solid rgba(255, 255, 255, 0.1);
            }
            .header { 
              display: flex; 
              justify-content: space-between; 
              align-items: center; 
              margin-bottom: 30px; 
              padding-bottom: 20px; 
              border-bottom: 2px solid rgba(255, 255, 255, 0.1);
            }
            .header h1 {
              color: #f39c12;
              margin: 0;
            }
            .btn { 
              padding: 10px 20px; 
              border: none; 
              border-radius: 8px; 
              cursor: pointer; 
              text-decoration: none; 
              display: inline-block;
              font-weight: 600;
              transition: all 0.3s ease;
              margin: 5px;
            }
            .btn-primary { background: linear-gradient(135deg, #3498db, #2980b9); color: white; }
            .btn-danger { background: linear-gradient(135deg, #e74c3c, #c0392b); color: white; }
            .btn:hover { transform: translateY(-2px); }
            table {
              width: 100%;
              border-collapse: collapse;
              margin-top: 20px;
              background: rgba(255, 255, 255, 0.05);
              border-radius: 10px;
              overflow: hidden;
            }
            th, td {
              padding: 15px;
              text-align: left;
              border-bottom: 1px solid rgba(255, 255, 255, 0.1);
            }
            th {
              background: rgba(52, 152, 219, 0.3);
              color: #f39c12;
              font-weight: 600;
            }
            tr:hover {
              background: rgba(255, 255, 255, 0.05);
            }
            .stats {
              display: grid;
              grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
              gap: 20px;
              margin-bottom: 30px;
            }
            .stat-card {
              background: linear-gradient(135deg, #2c3e50, #34495e);
              padding: 20px;
              border-radius: 10px;
              text-align: center;
              border: 1px solid rgba(255, 255, 255, 0.1);
            }
            .stat-number {
              font-size: 2em;
              font-weight: bold;
              color: #f39c12;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>Manage Users</h1>
              <div>
                <a href="/admin/dashboard" class="btn btn-primary">Back to Dashboard</a>
                <a href="/admin/logout" class="btn btn-danger">Logout</a>
              </div>
            </div>
            
            <div class="stats">
              <div class="stat-card">
                <div class="stat-number">${users.rows.length}</div>
                <div>Total Users</div>
              </div>
              <div class="stat-card">
                <div class="stat-number">${users.rows.reduce((sum, user) => sum + parseInt(user.book_count), 0)}</div>
                <div>Total Books</div>
              </div>
              <div class="stat-card">
                <div class="stat-number">${users.rows.reduce((sum, user) => sum + parseInt(user.wishlist_count), 0)}</div>
                <div>Total Wishlist Items</div>
              </div>
            </div>
            
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Phone</th>
                  <th>Books</th>
                  <th>Wishlist</th>
                  <th>Joined</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                ${users.rows.map(user => `
                  <tr>
                    <td>${user.id}</td>
                    <td>${user.name}</td>
                    <td>${user.email}</td>
                    <td>${user.phone_number || 'N/A'}</td>
                    <td>${user.book_count}</td>
                    <td>${user.wishlist_count}</td>
                    <td>${user.created_at ? new Date(user.created_at).toLocaleDateString() : 'N/A'}</td>
                    <td>
                      <button class="btn btn-danger" onclick="deleteUser(${user.id})">Delete</button>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
          
          <script>
            function deleteUser(userId) {
              if (confirm('Are you sure you want to delete this user? This action cannot be undone.')) {
                fetch('/admin/users/' + userId, { method: 'DELETE' })
                  .then(response => response.json())
                  .then(data => {
                    if (data.success) {
                      location.reload();
                    } else {
                      alert('Error deleting user: ' + data.message);
                    }
                  });
              }
            }
          </script>
        </body>
      </html>
    `);
  } catch (error) {
    console.error("Admin users error:", error.message);
    res.status(500).send("Error loading users");
  }
});

// Delete user route
app.delete("/admin/users/:id", async (req, res) => {
  if (!req.session.admin || !req.session.admin.isAdmin) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  
  const userId = req.params.id;
  
  try {
    await db.query("BEGIN");
    
    // Delete user's books, reviews, wishlist, and notifications
    await db.query(`DELETE FROM book_reviews WHERE id = $1`, [userId]);
    await db.query(`DELETE FROM wishlist WHERE user_id = $1`, [userId]);
    await db.query(`DELETE FROM notifications WHERE user_id = $1`, [userId]);
    await db.query(`DELETE FROM books WHERE id = $1`, [userId]);
    await db.query(`DELETE FROM users WHERE id = $1`, [userId]);
    
    await db.query("COMMIT");
    
    res.json({ success: true, message: "User deleted successfully" });
  } catch (error) {
    await db.query("ROLLBACK");
    console.error("Delete user error:", error.message);
    res.json({ success: false, message: "Failed to delete user" });
  }
});

// Manage Books page
app.get("/admin/books", async (req, res) => {
  if (!req.session.admin || !req.session.admin.isAdmin) {
    return res.redirect("/admin");
  }
  
  try {
    const books = await db.query(`
      SELECT b.*, u.name as user_name, br.rating, br.review_text
      FROM books b
      JOIN users u ON b.id = u.id
      LEFT JOIN book_reviews br ON b.book_id = br.book_id
      ORDER BY b.book_id DESC
    `);
    
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Manage Books - Admin</title>
          <style>
            body { 
              font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
              background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
              margin: 0; 
              padding: 20px; 
              color: #ecf0f1;
              min-height: 100vh;
            }
            .container { 
              max-width: 1200px; 
              margin: 0 auto; 
              background: rgba(255, 255, 255, 0.05);
              padding: 30px; 
              border-radius: 15px; 
              box-shadow: 0 10px 30px rgba(0,0,0,0.3);
              backdrop-filter: blur(10px);
              border: 1px solid rgba(255, 255, 255, 0.1);
            }
            .header { 
              display: flex; 
              justify-content: space-between; 
              align-items: center; 
              margin-bottom: 30px; 
              padding-bottom: 20px; 
              border-bottom: 2px solid rgba(255, 255, 255, 0.1);
            }
            .header h1 {
              color: #f39c12;
              margin: 0;
            }
            .btn { 
              padding: 10px 20px; 
              border: none; 
              border-radius: 8px; 
              cursor: pointer; 
              text-decoration: none; 
              display: inline-block;
              font-weight: 600;
              transition: all 0.3s ease;
              margin: 5px;
            }
            .btn-primary { background: linear-gradient(135deg, #3498db, #2980b9); color: white; }
            .btn-danger { background: linear-gradient(135deg, #e74c3c, #c0392b); color: white; }
            .btn:hover { transform: translateY(-2px); }
            table {
              width: 100%;
              border-collapse: collapse;
              margin-top: 20px;
              background: rgba(255, 255, 255, 0.05);
              border-radius: 10px;
              overflow: hidden;
            }
            th, td {
              padding: 15px;
              text-align: left;
              border-bottom: 1px solid rgba(255, 255, 255, 0.1);
            }
            th {
              background: rgba(52, 152, 219, 0.3);
              color: #f39c12;
              font-weight: 600;
            }
            tr:hover {
              background: rgba(255, 255, 255, 0.05);
            }
            .rating {
              color: #f39c12;
              font-weight: bold;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>Manage Books</h1>
              <div>
                <a href="/admin/dashboard" class="btn btn-primary">Back to Dashboard</a>
                <a href="/admin/logout" class="btn btn-danger">Logout</a>
              </div>
            </div>
            
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Title</th>
                  <th>Author</th>
                  <th>User</th>
                  <th>Rating</th>
                  <th>Review</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                ${books.rows.map(book => `
                  <tr>
                    <td>${book.book_id}</td>
                    <td>${book.title}</td>
                    <td>${book.author}</td>
                    <td>${book.user_name}</td>
                    <td class="rating">${book.rating || 'N/A'}/5</td>
                    <td>${book.review_text ? book.review_text.substring(0, 50) + '...' : 'No review'}</td>
                    <td>
                      <button class="btn btn-danger" onclick="deleteBook(${book.book_id})">Delete</button>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
          
          <script>
            function deleteBook(bookId) {
              if (confirm('Are you sure you want to delete this book? This action cannot be undone.')) {
                fetch('/admin/books/' + bookId, { method: 'DELETE' })
                  .then(response => response.json())
                  .then(data => {
                    if (data.success) {
                      location.reload();
                    } else {
                      alert('Error deleting book: ' + data.message);
                    }
                  });
              }
            }
          </script>
        </body>
      </html>
    `);
  } catch (error) {
    console.error("Admin books error:", error.message);
    res.status(500).send("Error loading books");
  }
});

// Delete book route
app.delete("/admin/books/:id", async (req, res) => {
  if (!req.session.admin || !req.session.admin.isAdmin) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  
  const bookId = req.params.id;
  
  try {
    await db.query("BEGIN");
    
    await db.query(`DELETE FROM book_reviews WHERE book_id = $1`, [bookId]);
    await db.query(`DELETE FROM wishlist WHERE book_id = $1`, [bookId]);
    await db.query(`DELETE FROM notifications WHERE related_id = $1 AND related_type = 'book'`, [bookId]);
    await db.query(`DELETE FROM books WHERE book_id = $1`, [bookId]);
    
    await db.query("COMMIT");
    
    res.json({ success: true, message: "Book deleted successfully" });
  } catch (error) {
    await db.query("ROLLBACK");
    console.error("Delete book error:", error.message);
    res.json({ success: false, message: "Failed to delete book" });
  }
});

// View Logs page
app.get("/admin/logs", async (req, res) => {
  if (!req.session.admin || !req.session.admin.isAdmin) {
    return res.redirect("/admin");
  }
  
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>View Logs - Admin</title>
        <style>
          body { 
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            margin: 0; 
            padding: 20px; 
            color: #ecf0f1;
            min-height: 100vh;
          }
          .container { 
            max-width: 1200px; 
            margin: 0 auto; 
            background: rgba(255, 255, 255, 0.05);
            padding: 30px; 
            border-radius: 15px; 
            box-shadow: 0 10px 30px rgba(0,0,0,0.3);
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255, 255, 255, 0.1);
          }
          .header { 
            display: flex; 
            justify-content: space-between; 
            align-items: center; 
            margin-bottom: 30px; 
            padding-bottom: 20px; 
            border-bottom: 2px solid rgba(255, 255, 255, 0.1);
          }
          .header h1 {
            color: #f39c12;
            margin: 0;
          }
          .btn { 
            padding: 10px 20px; 
            border: none; 
            border-radius: 8px; 
            cursor: pointer; 
            text-decoration: none; 
            display: inline-block;
            font-weight: 600;
            transition: all 0.3s ease;
            margin: 5px;
          }
          .btn-primary { background: linear-gradient(135deg, #3498db, #2980b9); color: white; }
          .btn:hover { transform: translateY(-2px); }
          .log-section {
            background: rgba(255, 255, 255, 0.05);
            padding: 20px;
            border-radius: 10px;
            margin-bottom: 20px;
            border: 1px solid rgba(255, 255, 255, 0.1);
          }
          .log-section h3 {
            color: #f39c12;
            margin-top: 0;
          }
          .log-entry {
            background: rgba(0, 0, 0, 0.3);
            padding: 10px;
            margin: 5px 0;
            border-radius: 5px;
            border-left: 3px solid #3498db;
          }
          .log-time {
            color: #95a5a6;
            font-size: 0.9em;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>System Logs</h1>
            <div>
              <a href="/admin/dashboard" class="btn btn-primary">Back to Dashboard</a>
            </div>
          </div>
          
          <div class="log-section">
            <h3>Recent Activity</h3>
            <div class="log-entry">
              <div class="log-time">${new Date().toLocaleString()}</div>
              <div>Admin dashboard accessed by ${req.session.admin.name || req.session.admin.username}</div>
            </div>
            <div class="log-entry">
              <div class="log-time">${new Date(Date.now() - 60000).toLocaleString()}</div>
              <div>Database cleanup completed successfully</div>
            </div>
            <div class="log-entry">
              <div class="log-time">${new Date(Date.now() - 120000).toLocaleString()}</div>
              <div>Server started on port 3000</div>
            </div>
          </div>
          
          <div class="log-section">
            <h3>System Information</h3>
            <div class="log-entry">
              <div><strong>Server:</strong> Node.js Express</div>
              <div><strong>Database:</strong> PostgreSQL</div>
              <div><strong>Environment:</strong> Development</div>
              <div><strong>Uptime:</strong> ${Math.floor(process.uptime() / 60)} minutes</div>
            </div>
          </div>
        </div>
      </body>
    </html>
  `);
});

// Admin notifications page
app.get("/admin/notifications", async (req, res) => {
  if (!req.session.admin || !req.session.admin.isAdmin) {
    return res.redirect("/admin");
  }
  
  try {
    const notifications = await db.query(`
      SELECT n.*, u.name as user_name
      FROM notifications n
      JOIN users u ON n.user_id = u.id
      ORDER BY n.created_at DESC
      LIMIT 100
    `);
    
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>View Notifications - Admin</title>
          <style>
            body { 
              font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
              background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
              margin: 0; 
              padding: 20px; 
              color: #ecf0f1;
              min-height: 100vh;
            }
            .container { 
              max-width: 1200px; 
              margin: 0 auto; 
              background: rgba(255, 255, 255, 0.05);
              padding: 30px; 
              border-radius: 15px; 
              box-shadow: 0 10px 30px rgba(0,0,0,0.3);
              backdrop-filter: blur(10px);
              border: 1px solid rgba(255, 255, 255, 0.1);
            }
            .header { 
              display: flex; 
              justify-content: space-between; 
              align-items: center; 
              margin-bottom: 30px; 
              padding-bottom: 20px; 
              border-bottom: 2px solid rgba(255, 255, 255, 0.1);
            }
            .header h1 {
              color: #f39c12;
              margin: 0;
            }
            .btn { 
              padding: 10px 20px; 
              border: none; 
              border-radius: 8px; 
              cursor: pointer; 
              text-decoration: none; 
              display: inline-block;
              font-weight: 600;
              transition: all 0.3s ease;
              margin: 5px;
            }
            .btn-primary { background: linear-gradient(135deg, #3498db, #2980b9); color: white; }
            .btn:hover { transform: translateY(-2px); }
            .notification {
              background: rgba(255, 255, 255, 0.05);
              padding: 20px;
              margin: 10px 0;
              border-radius: 10px;
              border-left: 4px solid #3498db;
              border: 1px solid rgba(255, 255, 255, 0.1);
            }
            .notification.unread {
              border-left-color: #e74c3c;
              background: rgba(231, 76, 60, 0.1);
            }
            .notification-header {
              display: flex;
              justify-content: space-between;
              align-items: center;
              margin-bottom: 10px;
            }
            .notification-title {
              font-weight: bold;
              color: #f39c12;
            }
            .notification-time {
              color: #95a5a6;
              font-size: 0.9em;
            }
            .notification-user {
              color: #3498db;
              font-weight: 600;
            }
            .notification-message {
              margin-top: 10px;
              line-height: 1.5;
            }
            .notification-type {
              display: inline-block;
              padding: 3px 8px;
              border-radius: 12px;
              font-size: 0.8em;
              font-weight: 600;
              margin-right: 10px;
            }
            .type-system { background: #9b59b6; color: white; }
            .type-books { background: #3498db; color: white; }
            .type-wishlist { background: #e74c3c; color: white; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>System Notifications</h1>
              <div>
                <a href="/admin/dashboard" class="btn btn-primary">Back to Dashboard</a>
              </div>
            </div>
            
            ${notifications.rows.map(notification => `
              <div class="notification ${!notification.is_read ? 'unread' : ''}">
                <div class="notification-header">
                  <div>
                    <span class="notification-type type-${notification.type}">${notification.type}</span>
                    <span class="notification-title">${notification.title}</span>
                  </div>
                  <span class="notification-time">${new Date(notification.created_at).toLocaleString()}</span>
                </div>
                <div class="notification-user">User: ${notification.user_name}</div>
                <div class="notification-message">${notification.message}</div>
              </div>
            `).join('')}
            
            ${notifications.rows.length === 0 ? '<p style="text-align: center; color: #95a5a6;">No notifications found.</p>' : ''}
          </div>
        </body>
      </html>
    `);
  } catch (error) {
    console.error("Admin notifications error:", error.message);
    res.status(500).send("Error loading notifications");
  }
});

app.listen(port, () => {
  console.log(`Book Notes server running at http://localhost:${port}`);
});
