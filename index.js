import express from "express";
import bodyParser from "body-parser";
import pg from "pg";
import session from "express-session";

const app = express();
const port = 3000;

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static("public"));
app.set("view engine", "ejs");

app.use(session({
  secret: "booknote-secret-key",
  resave: false,
  saveUninitialized: false,
}));

const db = new pg.Client({
  user: "postgres",
  host: "localhost",
  database: "yourDataBaseName",
  password: "postgresPassword",
  port: 5432,   
});
db.connect();

let sort = "review_id";
let search;

// so Here I'm redirecting my root towards the account
app.get("/", (req, res) => {
  res.redirect("/account");
});

// display the register.ejs file so that the user can be regsitered
app.get("/account", (req, res) => {
  res.render("register.ejs");
});

// after correct registering it goes to the login setup
app.get("/login", (req, res) => {
  const message = req.session.message;
  const error = req.session.error;
  req.session.message = null;
  req.session.error = null;
  res.render("signIn.ejs", { message, error });
});

// storing the user info after registration
app.post("/", async (req, res) => {
  const { name, email, phone, password } = req.body;
  try {
    await db.query("BEGIN");
    const newUser = await db.query(
      `INSERT INTO users (name, email, phone_number, password)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [name, email, phone, password]
    );
    await db.query("COMMIT");
    console.log(" User registered:", newUser.rows[0]);
    req.session.message = " Registered successfully! Please sign in.";
    res.redirect("/login");
  } catch (error) {
    await db.query("ROLLBACK");
    console.error(" Registration error:", error);
    res.status(500).send("Registration failed. Please try again.");
  }
});

// validating the correct user sign in info for login
app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await db.query(
      `SELECT * FROM users WHERE email = $1 AND password = $2`,
      [email, password]
    );
    if (result.rows.length > 0) {
      req.session.user = result.rows[0];
      res.redirect("/home");
    } else {
      req.session.error = " Invalid email or password";
      res.redirect("/login");
    }
  } catch (err) {
    console.error("Sign In error:", err);
    req.session.error = " Internal server error";
    res.redirect("/login");
  }
});

//displaying the forgetting password method
app.get("/forget-password", (req, res) => {
  res.render("forgetPassword.ejs", { message: null, error: null });
});


//forgetting the previous one and having the new password
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

    await db.query(`UPDATE users SET password = $1 WHERE email = $2`, [
      newPassword,
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



// display home page when you login
app.get("/home", (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  res.render("home.ejs");
});

// user can see the sorted list of books belonging to the logged-in user
app.get("/sort", async (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  try {
    const response = await db.query(
      `SELECT * FROM books
       JOIN book_reviews ON books.book_id = book_reviews.book_id
       WHERE books.id = $1
       ORDER BY ${sort} ASC`,
      [req.session.user.id]
    );
    res.render("index.ejs", {
      search: search,
      data: response.rows,
    });
  } catch (error) {
    console.log("Could not execute query:", error);
    res.send("Error loading books.");
  }
});

// change the sorting view you want for your books to be
app.post("/sort", (req, res) => {
  sort = req.body.sort;
  res.redirect("/sort");
});

// add/update the review of the book
app.get("/book", async (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  const { title, author, coverId } = req.query;
  try {
    const response = await db.query(
      `SELECT * FROM books
       JOIN book_reviews ON books.book_id = book_reviews.book_id
       WHERE books.id = $1`,
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
    console.log("Error:", error);
  }
});

// updating the review
app.post("/updateReview", async (req, res) => {
  const { review_text, rating, bookId } = req.body;
  const currentDate = new Date().toISOString();
  try {
    await db.query(
      `UPDATE book_reviews
       SET review_text = $1, rating = $2, review_date = $3
       WHERE book_id = $4 AND id = $5`,
      [review_text, rating, currentDate, bookId, req.session.user.id]
    );
    res.redirect("/sort");
  } catch (error) {
    console.log("Error:", error);
  }
});

//you can add a  new book ,rating and review, tied to the logged-in user
app.post("/addBook", async (req, res) => {
  const { title, cover_id, author, review_text, rating } = req.body;
  try {
    await db.query("BEGIN");

    const newBook = await db.query(
      `INSERT INTO books (title, author, cover_id, id)
       VALUES ($1, $2, $3, $4)
       RETURNING book_id`,
      [title, author, cover_id, req.session.user.id]
    );

    await db.query(
      `INSERT INTO book_reviews (book_id, id, review_text, rating)
       VALUES ($1, $2, $3, $4)`,
      [newBook.rows[0].book_id, req.session.user.id, review_text, rating]
    );

    await db.query("COMMIT");
    res.redirect("/sort");
  } catch (error) {
    await db.query("ROLLBACK");
    console.log("An error occurred:", error);
    res.send("Failed to add book.");
  }
});

// Delete a book and its review (only if it belongs to the user logged in)
app.delete("/delete/:id", async (req, res) => {
  const bookId = req.params.id;
  try {
    await db.query("BEGIN");

    // Validate book ownership before deleting
    const check = await db.query(
      `SELECT * FROM books WHERE book_id = $1 AND id = $2`,
      [bookId, req.session.user.id]
    );

    if (check.rows.length === 0) {
      return res.status(403).send(" Unauthorized");
    }

    await db.query(`DELETE FROM book_reviews WHERE book_id = $1`, [bookId]);
    await db.query(`DELETE FROM books WHERE book_id = $1`, [bookId]);

    await db.query("COMMIT");
    res.sendStatus(200);
  } catch (error) {
    await db.query("ROLLBACK");
    console.log("An error occurred:", error);
    res.sendStatus(500);
  }
});

// show contact page
app.get("/contact", (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  res.render("contact.ejs");
});

// you can submit the message and below html is used for displaying of the message
app.post("/contact", (req, res) => {
  const { name, email, message } = req.body;
  console.log(`📬 New message from ${name} (${email}): ${message}`);
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
          <p>You’ll be redirected shortly.</p>
        </div>
      </body>
    </html>
  `);
});

// log out the session
app.get("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) console.log("Logout Error:", err);
    res.redirect("/login");
  });
});


// display all the books for the current loggedIn user
app.get("/myBooks", async (req, res) => {
  if (!req.session.user) return res.redirect("/login");

  const userId = req.session.user.id;

  try {
    const result = await db.query(
      `SELECT *
       FROM books
       JOIN book_reviews ON books.book_id = book_reviews.book_id
       WHERE books.id = $1
       ORDER BY book_reviews.review_date DESC`,
      [userId]
    );

    res.render("myBooks.ejs", { books: result.rows });

  } catch (err) {
    console.error("Error fetching books for user:", err);
    res.status(500).send("Server error");
  }
});


// wish list enrouting
app.get('/wishlist', async (req, res) => {
  const userId = req.session.user.id;

  try {
    const result = await db.query(
      `SELECT b.*
       FROM wishlist w
       JOIN books b ON w.book_id = b.book_id
       WHERE w.user_id = $1`,
      [userId]
    );

    res.render('wishlist.ejs', { books: result.rows });
  } catch (err) {
    console.error('Error loading wishlist:', err);
    res.status(500).send('Server Error');
  }
});

// adding a book to your wihslist for further studying
app.post("/wishlist/add", async (req, res) => {
  const userId = req.session.user?.id;
  const bookId = req.body.bookId;

  if (!userId) {
    req.session.error = "⚠️ You must be logged in to add to wishlist.";
    return res.redirect("/login");
  }
  if (!bookId) {
    req.session.error = "Book ID is missing. Please try again.";
    return res.redirect("/myBooks"); 
  }

  try {
    await db.query("BEGIN");

    const checkDuplicateSql = `SELECT * FROM wishlist WHERE user_id = $1 AND book_id = $2`;
    const duplicateCheckResult = await db.query(checkDuplicateSql, [userId, bookId]);

    if (duplicateCheckResult.rows.length > 0) {
      await db.query("ROLLBACK"); 
      console.log(`❕ Wishlist add failed: Book ${bookId} already in wishlist for user ${userId}`);
      req.session.error = "❕ This book is already in your wishlist.";
      return res.redirect("/myBooks"); 
    } else {
      const insertSql = `INSERT INTO wishlist (user_id, book_id) VALUES ($1, $2) RETURNING *`;
      const newWishlistItem = await db.query(insertSql, [userId, bookId]);

      await db.query("COMMIT");
      console.log(`Book ${bookId} added to wishlist for user ${userId}`);
      req.session.message = "Book added to your wishlist!";
      return res.redirect("/myBooks"); 
    }
  } catch (error) {
    await db.query("ROLLBACK");
    req.session.error = "Failed to add book to wishlist due to an unexpected error.";
    return res.redirect("/myBooks"); 
  }
});


// removing a book from the wish list
app.post('/wishlist/remove', async (req, res) => {
  const { bookId } = req.body;
  const userId = req.session.user.id; 

  try {
    await db.query(
      'DELETE FROM wishlist WHERE user_id = $1 AND book_id = $2',
      [userId, bookId]
    );
    res.redirect('/wishlist'); 
  } catch (err) {
    console.error('Error removing from wishlist:', err);
    res.status(500).send('Server Error');
  }
});



app.listen(port, () => {
  console.log(`📚 Book Notes server running at http://localhost:${port}`);
});
