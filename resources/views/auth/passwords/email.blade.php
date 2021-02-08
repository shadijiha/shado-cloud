@extends('layouts.app')

@section('body_class') login_body @endsection

@section('scripts')
    <!-- Background changing script -->
    <script>
        @php
            // Get all backgrounds with php
            $files = \Illuminate\Support\Facades\File::allFiles(public_path("/images/backgrounds/"));
            $file_src = array();

            foreach($files as $file)
            {
                array_push($file_src, url("/images/backgrounds/") . "/" . $file->getFilename());
            }
        @endphp

        const change_bg_every = 20; // Seconds
        setInterval(randomBg, change_bg_every * 1000);

        function randomBg() {
            const backgrounds = {!! json_encode($file_src) !!};

            let bg_name = backgrounds[Math.floor(Math.random() * backgrounds.length)].replaceAll("\\", "\\\\");
            document.body.style.backgroundImage = `url('${bg_name}')`;
        }

        window.addEventListener("load", randomBg);
    </script>
@endsection

@section('content')
    <div class="wrapper">
        <h1>Reset Password</h1>
        @if($errors->any())
            {!! implode('', $errors->all('<div class="error_message">:message</div>')) !!}
        @endif
        <form method="POST" action="{{ route('password.email') }}">
            @csrf
            <input type="email" placeholder="Email" id="email" name="email"
                   class="@error('email') is_invalid @enderror" value="{{ old('email') }}" required
                   autocomplete="email"/>

            <input type="submit" value="SEND PASSWORD RESET LINK"/>
        </form>
        <div class="bottom-text">
        </div>
        <div class="socials">
            <a href="#"><i class="fab fa-facebook-f"></i></a>
            <a href="#"><i class="fab fa-twitter"></i></a>
            <a href="#"><i class="fab fa-pinterest"></i></a>
            <a href="#"><i class="fab fa-linkedin-in"></i></a>
        </div>
    </div>
    <div id="overlay-area">

    </div>
@endsection
